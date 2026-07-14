import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApiProvider, ProviderResponse } from "promptfoo";
import { boundedErrorText, formatBoundedError } from "../boundedError.js";
import type { ProjectVerificationCase } from "./case.js";
import {
  buildCodexPlanInvocation,
  buildCopilotPlanInvocation,
  runPlanCommand,
  type PlanCommandRunner,
} from "./commands.js";
import {
  ProjectVerificationProviderId,
  type ProjectVerificationProviderId as ProjectVerificationProviderIdValue,
} from "./scorecard.js";
import { extractWeavekitPlan } from "./weavekitPlan.js";
import { loadWeavekitOpportunityDiagnostics } from "./weavekitDiagnostics.js";
import { loadWeavekitRunMetadata, type WeavekitRunMetadata } from "./weavekitRunMetadata.js";
import {
  ProjectVerificationWorkspaceMutationError,
  withProjectVerificationWorkspace,
} from "./workspace.js";

type CommandPlanProviderOptions = {
  definition: ProjectVerificationCase;
  artifactsDir: string;
  model: string;
  reasoningEffort: string;
  timeoutMs?: number;
  runCommand?: PlanCommandRunner;
};

export type RunWeavekitWorkflowArgs = {
  prompt: string;
  projectDir: string;
  sourcePath: string;
  outputRoot: string;
  includeVisualDesign: boolean;
  projectResearchMode: "direct" | "hve";
  projectResearchMaxToolCalls: number;
  portfolioPlanningMode: "auto" | "direct";
};

export type RunWeavekitWorkflow = (args: RunWeavekitWorkflowArgs) => Promise<void>;

type WeavekitSourceToProjectProviderOptions = {
  definition: ProjectVerificationCase;
  artifactsDir: string;
  runWorkflow?: RunWeavekitWorkflow;
};

export type CreateProjectVerificationProvidersOptions = {
  definition: ProjectVerificationCase;
  artifactsDir: string;
  providerIds?: ProjectVerificationProviderIdValue[];
  copilotModel?: string;
  codexModel?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
};

export function resolveProjectVerificationReasoningEffort(
  explicit: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return explicit ?? environment.PROJECT_VERIFICATION_REASONING_EFFORT ?? "low";
}

export class CopilotPlanProvider implements ApiProvider {
  constructor(private readonly options: CommandPlanProviderOptions) {}

  id(): string {
    return ProjectVerificationProviderId.COPILOT;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      return await withProjectVerificationWorkspace(this.options.definition, async (workspace) => {
        const artifactPath = join(this.options.artifactsDir, "copilot", "plan.md");
        await mkdir(join(this.options.artifactsDir, "copilot"), { recursive: true });
        const invocation = buildCopilotPlanInvocation({
          workspaceDir: workspace.rootDir,
          prompt,
          model: this.options.model,
          reasoningEffort: this.options.reasoningEffort,
        });
        const output = await (this.options.runCommand ?? runPlanCommand)(invocation, {
          timeoutMs: this.options.timeoutMs,
        });
        await writeFile(artifactPath, output, "utf8");
        return {
          output,
          metadata: {
            artifactPaths: [artifactPath],
            model: this.options.model,
            workspaceMutationVerified: true,
          },
        };
      });
    } catch (error) {
      const mutationResponse = preserveWorkspaceMutationResult(error);
      if (mutationResponse) return mutationResponse;
      return { error: formatBoundedError("Copilot plan provider failed", error) };
    }
  }
}

export class CodexPlanProvider implements ApiProvider {
  constructor(private readonly options: CommandPlanProviderOptions) {}

  id(): string {
    return ProjectVerificationProviderId.CODEX;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      return await withProjectVerificationWorkspace(this.options.definition, async (workspace) => {
        const artifactDir = join(this.options.artifactsDir, "codex");
        const artifactPath = join(artifactDir, "plan.md");
        const commandOutputPath = resolve(artifactPath);
        await mkdir(artifactDir, { recursive: true });
        const invocation = buildCodexPlanInvocation({
          workspaceDir: workspace.rootDir,
          prompt,
          outputPath: commandOutputPath,
          model: this.options.model,
          reasoningEffort: this.options.reasoningEffort,
        });
        const output = await (this.options.runCommand ?? runPlanCommand)(invocation, {
          timeoutMs: this.options.timeoutMs,
          outputPath: commandOutputPath,
        });
        await writeFile(artifactPath, output, "utf8");
        return {
          output,
          metadata: {
            artifactPaths: [artifactPath],
            model: this.options.model,
            workspaceMutationVerified: true,
          },
        };
      });
    } catch (error) {
      const mutationResponse = preserveWorkspaceMutationResult(error);
      if (mutationResponse) return mutationResponse;
      return { error: formatBoundedError("Codex plan provider failed", error) };
    }
  }
}

export class WeavekitSourceToProjectProvider implements ApiProvider {
  constructor(private readonly options: WeavekitSourceToProjectProviderOptions) {}

  id(): string {
    return ProjectVerificationProviderId.WEAVEKIT;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      return await withProjectVerificationWorkspace(this.options.definition, async (workspace) => {
        const outputRoot = join(this.options.artifactsDir, "weavekit", "runs");
        await mkdir(outputRoot, { recursive: true });
        const before = new Set(await listRunDirectories(outputRoot));
        let workflowError: unknown;
        try {
          await (this.options.runWorkflow ?? runDefaultWeavekitWorkflow)({
            prompt,
            projectDir: workspace.projectDir,
            sourcePath: workspace.sourcePath,
            outputRoot,
            includeVisualDesign: false,
            projectResearchMode: "direct",
            projectResearchMaxToolCalls: 12,
            portfolioPlanningMode: "direct",
          });
        } catch (error) {
          workflowError = error;
        }
        let runDir: string;
        let runMetadata: WeavekitRunMetadata;
        try {
          runDir = await discoverRunDirectory(outputRoot, before);
          runMetadata = await loadWeavekitRunMetadata(runDir);
        } catch (metadataError) {
          const workflowContext = workflowError
            ? ` after workflow failure: ${errorMessage(workflowError)}`
            : "";
          throw new Error(
            `Could not load weavekit run metadata${workflowContext}; ${errorMessage(metadataError)}`,
          );
        }
        const persistedRunMetadata = sanitizeWeavekitRunMetadata(runMetadata);
        const responseMetadata = {
          runDir,
          ...persistedRunMetadata,
          workspaceMutationVerified: true,
        };
        const usage = {
          ...(persistedRunMetadata.tokenUsage
            ? { tokenUsage: persistedRunMetadata.tokenUsage }
            : {}),
          ...(persistedRunMetadata.estimatedCostUsd !== undefined
            ? { cost: persistedRunMetadata.estimatedCostUsd }
            : {}),
        };
        if (workflowError || persistedRunMetadata.status === "failed") {
          const failure = workflowError ? workflowError : persistedRunMetadata.failure!;
          return {
            error: formatBoundedError("Weavekit source-to-project workflow failed", failure),
            ...usage,
            metadata: responseMetadata,
          };
        }
        const extracted = await extractWeavekitPlan(runDir);
        const opportunityDiagnostics = await loadWeavekitOpportunityDiagnostics(runDir);
        return {
          output: extracted.markdown,
          ...usage,
          metadata: {
            ...responseMetadata,
            artifactPaths: extracted.paths,
            planKind: extracted.kind,
            opportunityDiagnostics,
          },
        };
      });
    } catch (error) {
      const mutationResponse = preserveWorkspaceMutationResult(error);
      if (mutationResponse) return mutationResponse;
      return {
        error: formatBoundedError("Weavekit source-to-project provider failed", error),
      };
    }
  }
}

async function listRunDirectories(outputRoot: string): Promise<string[]> {
  return (await readdir(outputRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function discoverRunDirectory(outputRoot: string, before: Set<string>): Promise<string> {
  const newEntries = (await listRunDirectories(outputRoot)).filter((entry) => !before.has(entry));
  if (newEntries.length !== 1) {
    throw new Error(
      `Expected one weavekit run directory, found ${newEntries.length}: ${newEntries.join(", ")}`,
    );
  }
  return join(outputRoot, newEntries[0]!);
}

export function createProjectVerificationProviders(
  options: CreateProjectVerificationProvidersOptions,
): ApiProvider[] {
  const selected = new Set(
    options.providerIds ?? [
      ProjectVerificationProviderId.WEAVEKIT,
      ProjectVerificationProviderId.COPILOT,
      ProjectVerificationProviderId.CODEX,
    ],
  );
  const reasoningEffort = resolveProjectVerificationReasoningEffort(options.reasoningEffort);
  const providers: ApiProvider[] = [];
  if (selected.has(ProjectVerificationProviderId.WEAVEKIT)) {
    providers.push(
      new WeavekitSourceToProjectProvider({
        definition: options.definition,
        artifactsDir: options.artifactsDir,
      }),
    );
  }
  if (selected.has(ProjectVerificationProviderId.COPILOT)) {
    providers.push(
      new CopilotPlanProvider({
        definition: options.definition,
        artifactsDir: options.artifactsDir,
        model: options.copilotModel ?? process.env.PROJECT_VERIFICATION_COPILOT_MODEL ?? "gpt-5.4",
        reasoningEffort,
        timeoutMs: options.timeoutMs,
      }),
    );
  }
  if (selected.has(ProjectVerificationProviderId.CODEX)) {
    providers.push(
      new CodexPlanProvider({
        definition: options.definition,
        artifactsDir: options.artifactsDir,
        model:
          options.codexModel ?? process.env.PROJECT_VERIFICATION_CODEX_MODEL ?? "gpt-5.3-codex",
        reasoningEffort,
        timeoutMs: options.timeoutMs,
      }),
    );
  }
  if (providers.length === 0) {
    throw new Error("At least one source-to-project verification provider is required.");
  }
  return providers;
}

async function runDefaultWeavekitWorkflow(args: RunWeavekitWorkflowArgs): Promise<void> {
  const { runWorkflowCli } = await import("../../cli.js");
  await runWorkflowCli({
    command: "run",
    outputDir: args.outputRoot,
    staticTemplate: true,
    dryRun: false,
    noCache: true,
    template: "source-to-project",
    prompt: args.prompt,
    source: args.sourcePath,
    projectPath: args.projectDir,
    mode: "advisory",
    includeVisualDesign: args.includeVisualDesign,
    projectResearchMode: args.projectResearchMode,
    projectResearchMaxToolCalls: args.projectResearchMaxToolCalls,
    portfolioPlanningMode: args.portfolioPlanningMode,
  });
}

function preserveWorkspaceMutationResult(error: unknown): ProviderResponse | undefined {
  if (!(error instanceof ProjectVerificationWorkspaceMutationError)) return undefined;
  const response = error.result as ProviderResponse;
  const metadata = response.metadata ?? {};
  return {
    ...response,
    ...(typeof response.error === "string"
      ? { error: boundedErrorText(response.error) }
      : response.error === undefined
        ? {}
        : { error: boundedErrorText(response.error) }),
    metadata: {
      ...metadata,
      ...(typeof metadata.failure === "string"
        ? { failure: boundedErrorText(metadata.failure) }
        : {}),
      workspaceMutationVerified: false,
      workspaceMutationError: boundedErrorText(error),
    },
  };
}

function sanitizeWeavekitRunMetadata(metadata: WeavekitRunMetadata): WeavekitRunMetadata {
  return {
    ...metadata,
    ...(metadata.failure ? { failure: boundedErrorText(metadata.failure) } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
