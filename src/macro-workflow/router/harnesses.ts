import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { b } from "../../generated/baml_client/index.js";
import type { RouterResult, RouterRecommendation } from "../../generated/baml_client/index.js";
import {
  RouterRoute,
  type CapabilityCatalogEntry,
  type RouterDefaults,
  type RoutingPreferenceOverlay,
} from "../../config.js";
import type {
  HarnessAdapter,
  HarnessExecutionResult,
  HarnessRegistry,
  WorkflowExecutionContext,
} from "../harness.js";
import { createStaticHarnessRegistry } from "../harness.js";
import type { RuntimeWorkflowNode, WorkflowArtifactRef } from "../types.js";
import { WorkflowHarnessKind } from "../types.js";

export type RouterBamlClient = {
  RoutePrompt(
    userPrompt: string,
    routeTaxonomy: string,
    capabilityCatalogJson: string,
    preferenceOverlayJson: string,
    options?: { client?: string },
  ): Promise<RouterResult>;
};

export type RouterHarnessOptions = {
  config: RouterDefaults;
  baml?: RouterBamlClient;
};

const ROUTER_RESULT_PATH = "RouterResult.json";
const ROUTER_REPORT_PATH = "RouterReport.md";

export function createRouterHarnessRegistry(options: RouterHarnessOptions): HarnessRegistry {
  const bamlClient = options.baml ?? (b as unknown as RouterBamlClient);
  const bamlClientName = routerBamlClientNameForModel(options.config.primaryModel);
  const registry = createStaticHarnessRegistry();

  const researchAdapter: HarnessAdapter = async (node): Promise<HarnessExecutionResult> => {
    if (node.id !== "advise-prompt") {
      return { status: "passed", output: `Router skipped unsupported node ${node.id}.` };
    }
    const result = validateRouterResult(
      await bamlClient.RoutePrompt(
        node.prompt,
        renderRouteTaxonomy(),
        JSON.stringify(options.config.catalog, null, 2),
        JSON.stringify(options.config.preferences, null, 2),
        { client: bamlClientName },
      ),
    );
    const normalized = normalizeRouterResult(result);
    return {
      status: "passed",
      output: `Primary route: ${normalized.primary.route}. Rewritten prompt: ${normalized.primary.promptRewrite}`,
      payload: { routerResult: normalized },
      execution: {
        executor: "baml",
        operation: "RoutePrompt",
        mode: "plan",
        prompt: buildPromptPreview(node, options.config),
        model: options.config.primaryModel,
        calls: [
          {
            executor: "baml",
            operation: "RoutePrompt",
            mode: "plan",
            prompt: buildPromptPreview(node, options.config),
            model: options.config.primaryModel,
          },
        ],
      },
    };
  };

  const reportAdapter: HarnessAdapter = async (node, context): Promise<HarnessExecutionResult> => {
    const result = readRouterPayload(context);
    if (!result) {
      throw new Error("Router report requires advise-prompt payload.");
    }
    const markdown = renderRouterReport(result);
    const artifacts = await writeRouterArtifacts(context, result, markdown);
    return {
      status: "passed",
      output: `Router report generated for ${result.primary.route}.`,
      payload: {
        routerResult: result,
        routerReportMarkdown: markdown,
      },
      artifacts,
      execution: {
        executor: WorkflowHarnessKind.REPORTER,
        operation: node.id,
        mode: "report",
        prompt: node.prompt,
        model: node.model ?? "deterministic",
      },
    };
  };

  registry.set(WorkflowHarnessKind.RESEARCH, researchAdapter);
  registry.set(WorkflowHarnessKind.REPORTER, reportAdapter);
  return registry;
}

export function validateRouterResult(result: RouterResult): RouterResult {
  const promptRewrite = result.primary.promptRewrite?.trim();
  if (!promptRewrite) {
    throw new Error("Router primary recommendation requires a prompt rewrite.");
  }
  if (result.alternatives.length !== 2) {
    throw new Error("Router result must include exactly two alternatives.");
  }
  const primaryRoute = String(result.primary.route);
  const alternativeRoutes = result.alternatives.map((alternative) => String(alternative.route));
  if (new Set(alternativeRoutes).size !== alternativeRoutes.length) {
    throw new Error("Router alternatives must use distinct routes.");
  }
  if (alternativeRoutes.includes(primaryRoute)) {
    throw new Error("Router alternatives must be distinct from the primary route.");
  }
  return result;
}

export function isRouterHandoffCreateWorktreeEligible(input: {
  route: RouterRoute;
  targetProjectId?: string | null;
  branchOrWorktreeName?: string | null;
  harnessOrAgent?: string | null;
  promptRewrite?: string | null;
}): boolean {
  return Boolean(
    input.route === RouterRoute.MANUAL_HERDR_WORKTREE &&
    input.targetProjectId?.trim() &&
    input.branchOrWorktreeName?.trim() &&
    input.harnessOrAgent?.trim() &&
    input.promptRewrite?.trim(),
  );
}

function readRouterPayload(context: WorkflowExecutionContext) {
  const payload = context.payloads.get("advise-prompt");
  const result = payload?.routerResult;
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as ReturnType<typeof normalizeRouterResult>)
    : undefined;
}

function normalizeRouterResult(result: RouterResult) {
  const primary = normalizeRecommendation(result.primary);
  const alternatives = result.alternatives.slice(0, 2).map(normalizeRecommendation);
  return {
    primary,
    alternatives,
    catalogEvidence: result.catalogEvidence,
    preferenceEvidence: result.preferenceEvidence,
    warnings: result.warnings,
  };
}

function normalizeRecommendation(recommendation: RouterRecommendation) {
  const route = normalizeGeneratedRoute(String(recommendation.route));
  const promptRewrite = recommendation.promptRewrite?.trim() ?? "";
  const handoff = recommendation.handoff
    ? {
        ...recommendation.handoff,
        createWorktreeEligible: isRouterHandoffCreateWorktreeEligible({
          route,
          targetProjectId: recommendation.handoff.targetProjectId,
          branchOrWorktreeName: recommendation.handoff.branchOrWorktreeName,
          harnessOrAgent: recommendation.handoff.harnessOrAgent,
          promptRewrite,
        }),
      }
    : undefined;
  return {
    ...recommendation,
    route,
    promptRewrite,
    ...(handoff ? { handoff } : {}),
  };
}

function normalizeGeneratedRoute(route: string): RouterRoute {
  const routeMap: Record<string, RouterRoute> = {
    DirectAnswer: RouterRoute.DIRECT_ANSWER,
    RefinePrompt: RouterRoute.REFINE_PROMPT,
    GoalPrompt: RouterRoute.GOAL_PROMPT,
    Plan: RouterRoute.PLAN,
    GrillWithDocs: RouterRoute.GRILL_WITH_DOCS,
    Research: RouterRoute.RESEARCH,
    LocalCodeChange: RouterRoute.LOCAL_CODE_CHANGE,
    FleetParallel: RouterRoute.FLEET_PARALLEL,
    RemoteDelegatePr: RouterRoute.REMOTE_DELEGATE_PR,
    DecisionCouncil: RouterRoute.DECISION_COUNCIL,
    SourceToProject: RouterRoute.SOURCE_TO_PROJECT,
    ManualHerdrWorktree: RouterRoute.MANUAL_HERDR_WORKTREE,
  };
  return routeMap[route] ?? RouterRoute.GRILL_WITH_DOCS;
}

function renderRouteTaxonomy(): string {
  return [
    "direct-answer: Narrow questions or simple guidance.",
    "refine-prompt: User wants a clearer prompt.",
    "goal-prompt: Durable goal-mode execution or goal-mode prompt rewrite.",
    "plan: Implementation plan before coding.",
    "grill-with-docs: Ambiguous prompt or missing safe handoff fields.",
    "research: External/current evidence or multi-source synthesis.",
    "local-code-change: Local coding harness in current worktree.",
    "fleet-parallel: Complex work decomposable across parallel subagents.",
    "remote-delegate-pr: Remote/cloud PR-producing agent handoff.",
    "decision-council: Tradeoff-heavy recommendation.",
    "source-to-project: Map source artifact against target project.",
    "manual-herdr-worktree: Manual Herdr Create Worktree handoff.",
  ].join("\n");
}

function buildPromptPreview(node: RuntimeWorkflowNode, config: RouterDefaults): string {
  return [
    "Advise next action for prompt:",
    node.prompt,
    "",
    `Catalog entries: ${config.catalog.map((entry) => entry.id).join(", ")}`,
    `Preference overlays: ${config.preferences.map((entry) => entry.id).join(", ")}`,
  ].join("\n");
}

export function routerBamlClientNameForModel(model: string): string {
  if (model === "gpt-5.5") return "CopilotProxyGpt55";
  if (model === "claude-opus-4.8") return "CopilotProxyClaudeOpus48";
  if (model === "claude-sonnet-5") return "CopilotProxyClaudeSonnet5";
  if (model === "gpt-5-mini") return "CopilotProxyGpt5Mini";
  throw new Error(`Unsupported router primary model: ${model}.`);
}

function renderRouterReport(result: ReturnType<typeof normalizeRouterResult>): string {
  return [
    "# Router Report",
    "",
    "## Primary Recommendation",
    "",
    `- Route: ${result.primary.route}`,
    `- Harness: ${result.primary.harness}`,
    ...(result.primary.ability ? [`- Ability: ${result.primary.ability}`] : []),
    ...(result.primary.model ? [`- Model: ${result.primary.model}`] : []),
    `- Confidence: ${result.primary.confidence}`,
    `- Rationale: ${result.primary.rationale}`,
    "",
    "### Prompt Rewrite",
    "",
    result.primary.promptRewrite,
    "",
    "## Alternatives",
    "",
    ...result.alternatives.flatMap((alternative, index) => [
      `${index + 1}. **${alternative.route}** via ${alternative.harness}${alternative.ability ? `/${alternative.ability}` : ""}: ${alternative.rationale}`,
    ]),
    "",
    "## Score Dimensions",
    "",
    ...result.primary.scores.map(
      (score) => `- ${score.dimension}: ${score.score}/5 - ${score.rationale}`,
    ),
    "",
    "## Evidence",
    "",
    ...(result.catalogEvidence.length
      ? result.catalogEvidence.map((evidence) => `- Catalog: ${evidence}`)
      : ["- Catalog: none recorded"]),
    ...(result.preferenceEvidence.length
      ? result.preferenceEvidence.map((evidence) => `- Preference: ${evidence}`)
      : ["- Preference: none recorded"]),
    "",
    "## Warnings",
    "",
    ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["None."]),
  ].join("\n");
}

async function writeRouterArtifacts(
  context: WorkflowExecutionContext,
  result: ReturnType<typeof normalizeRouterResult>,
  markdown: string,
): Promise<WorkflowArtifactRef[] | undefined> {
  if (!context.outputDir) {
    return undefined;
  }
  await mkdir(context.outputDir, { recursive: true });
  const jsonPath = join(context.outputDir, ROUTER_RESULT_PATH);
  const markdownPath = join(context.outputDir, ROUTER_REPORT_PATH);
  await Promise.all([
    writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8"),
    writeFile(markdownPath, markdown, "utf8"),
  ]);
  return [
    {
      kind: "json",
      path: jsonPath,
      description: "Router typed recommendation.",
    },
    {
      kind: "markdown",
      path: markdownPath,
      description: "Router Markdown report.",
    },
  ];
}

export function catalogEvidenceLabel(entry: CapabilityCatalogEntry): string {
  return `${entry.id} (${entry.route}, ${entry.harness})`;
}

export function preferenceEvidenceLabel(entry: RoutingPreferenceOverlay): string {
  return `${entry.id}: ${entry.rationale}`;
}
