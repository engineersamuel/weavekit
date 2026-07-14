import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";
import {
  CodexPlanProvider,
  CopilotPlanProvider,
  resolveProjectVerificationReasoningEffort,
  WeavekitSourceToProjectProvider,
} from "../../../src/eval/sourceToProjectVerification/providers.js";

async function createCase(): Promise<ProjectVerificationCase> {
  const root = await mkdtemp(join(tmpdir(), "weavekit-project-provider-case-"));
  const projectDir = join(root, "project");
  const sourcePath = join(root, "source.md");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "app.ts"), "export const value = 1;\n", "utf8");
  await writeFile(sourcePath, "# Source\n", "utf8");
  return {
    id: "provider-case",
    title: "Provider case",
    objective: "Plan the improvement.",
    projectDir,
    sourcePath,
    expectedPractices: [
      {
        id: "practice",
        title: "Practice",
        sourceExpectation: "Apply it.",
        projectEvidence: ["app.ts"],
        expectedPlanActions: ["change app.ts"],
      },
    ],
    antiGoals: [],
    rubric: [{ criterion: "coverage", weight: 1, levels: "complete" }],
  };
}

describe("source-to-project verification providers", () => {
  it("defaults plan baselines to bounded low reasoning while preserving overrides", () => {
    expect(resolveProjectVerificationReasoningEffort(undefined, {})).toBe("low");
    expect(
      resolveProjectVerificationReasoningEffort(undefined, {
        PROJECT_VERIFICATION_REASONING_EFFORT: "medium",
      }),
    ).toBe("medium");
    expect(resolveProjectVerificationReasoningEffort("high", {})).toBe("high");
  });

  it("persists a Copilot plan and invokes the read-only plan command", async () => {
    const definition = await createCase();
    const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-copilot-provider-"));
    let command = "";
    const provider = new CopilotPlanProvider({
      definition,
      artifactsDir,
      model: "gpt-5.4",
      reasoningEffort: "high",
      runCommand: async (invocation) => {
        command = `${invocation.command} ${invocation.args.join(" ")}`;
        return "# Copilot plan\n";
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response.error).toBeUndefined();
    expect(response.output).toBe("# Copilot plan\n");
    expect(command).toContain("copilot --plan");
    expect(command).toContain("--available-tools=view,rg,glob");
    const artifactPath = join(artifactsDir, "copilot", "plan.md");
    expect(await readFile(artifactPath, "utf8")).toBe("# Copilot plan\n");
    expect(response.metadata?.artifactPaths).toEqual([artifactPath]);
  });

  it("preserves a generated plan while reporting workspace mutation separately", async () => {
    const definition = await createCase();
    const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-mutating-provider-"));
    const provider = new CopilotPlanProvider({
      definition,
      artifactsDir,
      model: "gpt-5.4",
      reasoningEffort: "low",
      runCommand: async (invocation) => {
        await writeFile(
          join(invocation.cwd, "project", "app.ts"),
          "export const value = 2;\n",
          "utf8",
        );
        return "# Generated despite mutation\n";
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response.error).toBeUndefined();
    expect(response.output).toBe("# Generated despite mutation\n");
    expect(response.metadata).toMatchObject({
      workspaceMutationVerified: false,
      workspaceMutationError: expect.stringMatching(/modified the controlled target project/i),
    });
    const artifactPath = join(artifactsDir, "copilot", "plan.md");
    expect(response.metadata?.artifactPaths).toEqual([artifactPath]);
    expect(await readFile(artifactPath, "utf8")).toBe("# Generated despite mutation\n");
  });

  it("persists the Codex final message from a read-only exec invocation", async () => {
    const definition = await createCase();
    const artifactsDir = relative(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "weavekit-codex-provider-")),
    );
    let command = "";
    let outputPath = "";
    const provider = new CodexPlanProvider({
      definition,
      artifactsDir,
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      runCommand: async (invocation, options) => {
        command = `${invocation.command} ${invocation.args.join(" ")}`;
        outputPath = options?.outputPath ?? "";
        return "# Codex plan\n";
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response.error).toBeUndefined();
    expect(response.output).toBe("# Codex plan\n");
    expect(command).toContain("codex exec");
    expect(command).toContain("--sandbox read-only");
    const artifactPath = join(artifactsDir, "codex", "plan.md");
    expect(command).toContain(resolve(artifactPath));
    expect(outputPath).toBe(resolve(artifactPath));
    expect(await readFile(artifactPath, "utf8")).toBe("# Codex plan\n");
    expect(response.metadata?.artifactPaths).toEqual([artifactPath]);
  });

  it.each(["Copilot", "Codex"] as const)(
    "redacts and bounds %s command failures before returning a ProviderResponse",
    async (providerName) => {
      const definition = await createCase();
      const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-command-failure-provider-"));
      const options = {
        definition,
        artifactsDir,
        model: providerName === "Copilot" ? "gpt-5.4" : "gpt-5.3-codex",
        reasoningEffort: "low",
        runCommand: async () => {
          throw new Error(secretBearingLongFailure("command failed"));
        },
      };
      const planProvider =
        providerName === "Copilot"
          ? new CopilotPlanProvider(options)
          : new CodexPlanProvider(options);

      const response = await planProvider.callApi("Plan the improvement.");

      expect(response.error).toMatch(new RegExp(`^${providerName} plan provider failed:`));
      expectBoundedAndRedacted(response.error);
      expect(response.error).toContain("command failed");
    },
  );

  it("runs the real weavekit workflow seam and returns its captured full plan", async () => {
    const definition = await createCase();
    const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-workflow-provider-"));
    let observedProjectDir = "";
    const provider = new WeavekitSourceToProjectProvider({
      definition,
      artifactsDir,
      runWorkflow: async (args) => {
        observedProjectDir = args.projectDir;
        expect(args).toMatchObject({
          includeVisualDesign: false,
          projectResearchMode: "direct",
          projectResearchMaxToolCalls: 12,
          portfolioPlanningMode: "direct",
        });
        expect(await readFile(join(args.projectDir, "app.ts"), "utf8")).toContain("value = 1");
        expect(await readFile(args.sourcePath, "utf8")).toBe("# Source\n");
        const runDir = join(args.outputRoot, "run-1");
        await mkdir(join(runDir, "raw-plans"), { recursive: true });
        await writeFile(join(runDir, "raw-plans", "plan-portfolio-full.md"), "# Weavekit plan\n");
        await writeFile(
          join(runDir, "opportunity-mapping.payload.json"),
          JSON.stringify({
            councilInputReview: { opportunities: [{ id: "o1" }], bundles: [] },
          }),
        );
        await writeFile(
          join(runDir, "council-review.payload.json"),
          JSON.stringify({ opportunityAcceptances: [{ id: "o1", accepted: true }] }),
        );
        await writeFile(
          join(runDir, "plan-portfolio.payload.json"),
          JSON.stringify({ plan: { opportunityIds: ["o1"] }, sourcePlans: [] }),
        );
        await writeWorkflowState(runDir, {
          runId: "run-1",
          status: "passed",
          nodeResults: [],
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cachedInputTokens: 0,
            totalTokens: 1200,
            estimatedCostUsd: 0.42,
          },
        });
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response.error).toBeUndefined();
    expect(response.output).toBe("# Weavekit plan\n");
    expect(observedProjectDir).toContain("weavekit-project-verification-");
    expect(response.metadata?.planKind).toBe("full-plan");
    expect(response.metadata?.artifactPaths).toEqual([
      join(artifactsDir, "weavekit", "runs", "run-1", "raw-plans", "plan-portfolio-full.md"),
    ]);
    expect(response.metadata?.opportunityDiagnostics).toMatchObject({
      discoveredOpportunityCount: 1,
      acceptedOpportunityCount: 1,
      acceptedOpportunityRetention: 1,
      acceptedPracticeRetention: null,
    });
    expect(response).toMatchObject({
      tokenUsage: { prompt: 1000, completion: 200, cached: 0, total: 1200 },
      cost: 0.42,
      metadata: {
        runId: "run-1",
        status: "passed",
        tokenUsage: { prompt: 1000, completion: 200, cached: 0, total: 1200 },
        estimatedCostUsd: 0.42,
      },
    });
  });

  it("returns failed workflow error and usage after discovering its single run directory", async () => {
    const definition = await createCase();
    const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-failed-workflow-provider-"));
    const provider = new WeavekitSourceToProjectProvider({
      definition,
      artifactsDir,
      runWorkflow: async ({ outputRoot }) => {
        const runDir = join(outputRoot, "run-failed");
        await mkdir(runDir, { recursive: true });
        await writeWorkflowState(runDir, {
          runId: "run-failed",
          status: "failed",
          nodeResults: [
            {
              nodeId: "audit-portfolio",
              status: "failed",
              output: "",
              error: "Portfolio coverage remains incomplete",
            },
          ],
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cachedInputTokens: 0,
            totalTokens: 1200,
            estimatedCostUsd: 0.42,
          },
        });
        throw new Error("Workflow failed at audit-portfolio");
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response).toMatchObject({
      error: expect.stringMatching(/Workflow failed at audit-portfolio/),
      tokenUsage: { prompt: 1000, completion: 200, cached: 0, total: 1200 },
      cost: 0.42,
      metadata: {
        runDir: join(artifactsDir, "weavekit", "runs", "run-failed"),
        runId: "run-failed",
        status: "failed",
        failure: "Portfolio coverage remains incomplete",
        tokenUsage: { prompt: 1000, completion: 200, cached: 0, total: 1200 },
        estimatedCostUsd: 0.42,
        workspaceMutationVerified: true,
      },
    });
  });

  it("redacts and bounds failed Weavekit and workspace-mutation response metadata", async () => {
    const definition = await createCase();
    const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-redacted-workflow-provider-"));
    const provider = new WeavekitSourceToProjectProvider({
      definition,
      artifactsDir,
      runWorkflow: async ({ outputRoot, projectDir }) => {
        const runDir = join(outputRoot, "run-secret-failure");
        await mkdir(runDir, { recursive: true });
        await writeWorkflowState(runDir, {
          runId: "run-secret-failure",
          status: "failed",
          nodeResults: [
            {
              nodeId: "plan-portfolio",
              status: "failed",
              output: "",
              error: secretBearingLongFailure("workflow failed"),
            },
          ],
        });
        for (let index = 0; index < 12; index += 1) {
          await writeFile(
            join(projectDir, `token=workspace-secret-${index}-${"x".repeat(120)}`),
            "mutation\n",
          );
        }
        throw new Error(secretBearingLongFailure("workflow command failed"));
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response.error).toMatch(/^Weavekit source-to-project workflow failed:/);
    expectBoundedAndRedacted(response.error);
    expect(response.metadata?.workspaceMutationVerified).toBe(false);
    expectBoundedAndRedacted(response.metadata?.workspaceMutationError);
    expectBoundedAndRedacted(response.metadata?.failure);
  });

  it("reports both the workflow failure and an unreadable discovered run state", async () => {
    const definition = await createCase();
    const artifactsDir = await mkdtemp(join(tmpdir(), "weavekit-invalid-run-provider-"));
    const provider = new WeavekitSourceToProjectProvider({
      definition,
      artifactsDir,
      runWorkflow: async ({ outputRoot }) => {
        await mkdir(join(outputRoot, "run-invalid"), { recursive: true });
        throw new Error("Original workflow failure");
      },
    });

    const response = await provider.callApi("Plan the improvement.");

    expect(response.error).toMatch(/Original workflow failure/);
    expect(response.error).toMatch(/workflow-state\.json/);
  });
});

async function writeWorkflowState(runDir: string, state: unknown): Promise<void> {
  await writeFile(join(runDir, "workflow-state.json"), JSON.stringify(state), "utf8");
}

const SECRET_VALUES = [
  "bearer-secret-value",
  "api-key-secret-value",
  "token-secret-value",
  "named-secret-value",
  "password-secret-value",
  "sk-project-1234567890-secret",
  "plain-environment-secret-value",
  "proxy-environment-secret-value",
  "123456789-environment-token",
  "quoted-environment-secret-value",
  "mixed-environment-password-value",
  "private-environment-key-value",
  "access-environment-token-value",
];

function secretBearingLongFailure(context: string): string {
  return [
    context,
    `Authorization: Bearer ${SECRET_VALUES[0]}`,
    `api_key=${SECRET_VALUES[1]}`,
    `token=${SECRET_VALUES[2]}`,
    `secret=${SECRET_VALUES[3]}`,
    `password=${SECRET_VALUES[4]}`,
    SECRET_VALUES[5],
    `PROJECT_VERIFICATION_JUDGE_API_KEY=${SECRET_VALUES[6]}`,
    `COPILOT_PROXY_API_KEY : "${SECRET_VALUES[7]}"`,
    `TELEGRAM_BOT_TOKEN=${SECRET_VALUES[8]}`,
    `SERVICE_SECRET = '${SECRET_VALUES[9]}'`,
    `Database_Password:${SECRET_VALUES[10]}`,
    `SIGNING_PRIVATE_KEY=${SECRET_VALUES[11]}`,
    `GitHub_Access_Token = "${SECRET_VALUES[12]}"`,
    `stdout=${"o".repeat(2_000)}`,
    `stderr=${"e".repeat(2_000)}`,
  ].join(" ");
}

function expectBoundedAndRedacted(value: unknown): void {
  expect(typeof value).toBe("string");
  const message = String(value);
  expect(message.length).toBeLessThanOrEqual(1_024);
  for (const secret of SECRET_VALUES) expect(message).not.toContain(secret);
}
