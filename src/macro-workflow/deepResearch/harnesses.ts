import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DeepResearchProvider,
  type DeepResearchDefaults,
  type ToolingDefaults,
} from "../../config.js";
import { getEnabledRemoteMcpSpecs } from "../../flue/mcpConfig.js";
import type { RemoteFlueMcpSpec } from "../../flue/mcpConfig.js";
import type {
  DeepResearchConfig,
  DeepResearchEvidence,
  DeepResearchPriorState,
  DeepResearchQuestion,
  DeepResearchReport,
  ResearchIterationAssessment,
  ResearchQuestionSet,
} from "../../generated/baml_client/index.js";
import type {
  HarnessAdapter,
  HarnessExecutionResult,
  HarnessRegistry,
  WorkflowExecutionContext,
} from "../harness.js";
import { createStaticHarnessRegistry } from "../harness.js";
import type { WorkflowDynamicExpander } from "../runner.js";
import { runMacroWorkflow } from "../runner.js";
import { materializeWorkflowPlan } from "../templates.js";
import type {
  RuntimeWorkflowNode,
  WorkflowArtifactRef,
  WorkflowExecutionCall,
  WorkflowExecutionMetadata,
  WorkflowNodePayload,
} from "../types.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "../types.js";
import type { CopilotCapabilityScope } from "../sourceToProject/harnesses.js";
import {
  createLiveDeepResearchBamlClient as createLiveDeepResearchBamlClientImpl,
  type DeepResearchBamlClient,
} from "./bamlAdapters.js";

const execFileAsync = promisify(execFile);

const DEFAULT_DEEP_RESEARCH_CONFIG: DeepResearchConfig = {
  providers: [
    DeepResearchProvider.GROK,
    DeepResearchProvider.EXA,
    DeepResearchProvider.COPILOT_LAST30DAYS,
  ],
  maxIterations: 3,
  questionsPerIteration: 5,
  maxResultsPerQuestion: 5,
  providerRetryAttempts: 1,
  visualize: false,
};

const DEEP_RESEARCH_REPORT_PATH = "DeepResearchReport.md";
const DEEP_RESEARCH_PROVIDER_SONNET_MODEL = "claude-sonnet-5";
const DEFAULT_COPILOT_LAST30DAYS_MODEL = DEEP_RESEARCH_PROVIDER_SONNET_MODEL;
const DEFAULT_COPILOT_LAST30DAYS_MAX_TOOL_CALLS = 60;
const REPORT_INPUT_EXCERPT_LIMIT = 700;
const REPORT_INPUT_CONTENT_LIMIT = 900;
const FALLBACK_REPORT_EVIDENCE_MATRIX_LIMIT = 80;

type DeepResearchStep =
  | "generate-questions"
  | "provider-research"
  | "assess-iteration"
  | "compile-report"
  | "visualize-report";

type DeepResearchMode =
  | "local-only"
  | "official-docs"
  | "web-lookup"
  | "recency-social"
  | "deep-research";

const DeepResearchMode = {
  LOCAL_ONLY: "local-only",
  OFFICIAL_DOCS: "official-docs",
  WEB_LOOKUP: "web-lookup",
  RECENCY_SOCIAL: "recency-social",
  DEEP_RESEARCH: "deep-research",
} as const satisfies Record<string, DeepResearchMode>;

export type DeepResearchProviderEvidence = Omit<DeepResearchEvidence, "id"> & {
  id?: string;
};

export type DeepResearchProviderFailure = {
  provider: string;
  iteration: number;
  retryCount: number;
  message: string;
  questionIds: string[];
};

export type DeepResearchProviderClient = {
  search(args: {
    provider: string;
    iteration: number;
    nodeId?: string;
    deepResearchRunId?: string;
    questions: DeepResearchQuestion[];
    queries: string[];
    maxResultsPerQuestion: number;
    objective: string;
  }): Promise<DeepResearchProviderEvidence[]>;
};

type DeepResearchProviderSearchArgs = Parameters<DeepResearchProviderClient["search"]>[0];

export type DeepResearchExaMcpClient = {
  web_search_exa(args: { query: string; numResults?: number }): Promise<unknown>;
  web_fetch_exa?(args: { url: string }): Promise<unknown>;
};

export type DeepResearchMcpTool = {
  name: string;
  run(context: {
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): unknown | Promise<unknown>;
};

export type DeepResearchDirectMcpTool = {
  name: string;
};

export type DeepResearchDirectMcpClient = {
  listTools(
    args?: { cursor?: string },
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean },
  ): Promise<{
    tools: DeepResearchDirectMcpTool[];
    nextCursor?: string;
  }>;
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean; signal?: AbortSignal },
  ): Promise<unknown>;
  close(): Promise<void>;
};

export type ConnectDeepResearchMcpClient = (
  spec: RemoteFlueMcpSpec,
) => Promise<DeepResearchDirectMcpClient>;

export type DeepResearchCopilotClient = {
  model?: string;
  run(args: {
    prompt: string;
    mode: "research" | "plan";
    model?: string;
    maxToolCalls?: number;
    operation?: string;
    nodeId?: string;
    label?: string;
    capabilityScope?: CopilotCapabilityScope;
  }): Promise<string>;
};

export type DeepResearchHarnessOptions = {
  config?: Partial<DeepResearchDefaults>;
  baml?: DeepResearchBamlClient;
  providers?: Partial<Record<DeepResearchProvider, DeepResearchProviderClient>>;
  exaMcp?: DeepResearchExaMcpClient;
  grok?: {
    command?: string;
    timeoutMs?: number;
  };
  copilot?: DeepResearchCopilotClient;
  tooling?: ToolingDefaults;
  cwd?: string;
  homeDirectory?: string;
};

export type BoundedDeepResearchRunArgs = {
  objective: string;
  config?: Partial<DeepResearchDefaults>;
  outputDir?: string;
};

export type BoundedDeepResearchRunner = {
  run(args: BoundedDeepResearchRunArgs): Promise<DeepResearchReport>;
};

export type DefaultDeepResearchExaMcpConnection = {
  client?: DeepResearchExaMcpClient;
  close(): Promise<void>;
};

export function createLiveDeepResearchBamlClient(
  options: Parameters<typeof createLiveDeepResearchBamlClientImpl>[0] = {},
) {
  return createLiveDeepResearchBamlClientImpl(options);
}

export function createBoundedDeepResearchRunner(
  options: DeepResearchHarnessOptions = {},
): BoundedDeepResearchRunner {
  return {
    async run(args) {
      const config = normalizeDeepResearchConfig({ ...options.config, ...args.config });
      const typedConfig = toDeepResearchDefaults(config);
      const plan = materializeWorkflowPlan("deep-research", {
        objective: args.objective,
        providers: typedConfig.providers,
        maxIterations: config.maxIterations,
        questionsPerIteration: config.questionsPerIteration,
        maxResultsPerQuestion: config.maxResultsPerQuestion,
        providerRetryAttempts: config.providerRetryAttempts,
        visualize: config.visualize,
      });
      const state = await runMacroWorkflow(plan, {
        harnesses: createDeepResearchHarnessRegistry({ ...options, config: typedConfig }),
        expandAfterNode: createDeepResearchDynamicExpander(),
        outputDir: args.outputDir,
      });
      const report = state.nodeResults.find((result) => result.nodeId === "deep-research-report")
        ?.payload?.deepResearchReport;
      if (state.status !== "passed" || !isDeepResearchReport(report)) {
        const failed = state.nodeResults.find((result) => result.status === "failed");
        throw new Error(
          failed?.error ?? `Bounded deep research failed with status ${state.status}.`,
        );
      }
      return report;
    },
  };
}

function toDeepResearchDefaults(config: DeepResearchConfig): DeepResearchDefaults {
  const providers = config.providers.filter((provider): provider is DeepResearchProvider =>
    Object.values(DeepResearchProvider).includes(provider as DeepResearchProvider),
  );
  return {
    providers:
      providers.length > 0
        ? providers
        : (DEFAULT_DEEP_RESEARCH_CONFIG.providers as DeepResearchProvider[]),
    maxIterations: config.maxIterations,
    questionsPerIteration: config.questionsPerIteration,
    maxResultsPerQuestion: config.maxResultsPerQuestion,
    providerRetryAttempts: config.providerRetryAttempts,
    visualize: config.visualize,
  };
}

export function createExaMcpClientFromTools(
  tools: DeepResearchMcpTool[],
): DeepResearchExaMcpClient | undefined {
  const searchTool = findMcpTool(tools, ["web_search_exa", "mcp__exa__web_search_exa"]);
  if (!searchTool) {
    return undefined;
  }
  const fetchTool = findMcpTool(tools, ["web_fetch_exa", "mcp__exa__web_fetch_exa"]);
  return {
    async web_search_exa(args) {
      return searchTool.run({ input: args });
    },
    ...(fetchTool
      ? {
          async web_fetch_exa(args: { url: string }) {
            return fetchTool.run({ input: args });
          },
        }
      : {}),
  };
}

export async function createDefaultDeepResearchExaMcpConnection(
  options: {
    env?: NodeJS.ProcessEnv;
    connectMcpClient?: ConnectDeepResearchMcpClient;
  } = {},
): Promise<DefaultDeepResearchExaMcpConnection> {
  const exaSpecs = getEnabledRemoteMcpSpecs(options.env ?? process.env).filter(
    (spec) => spec.name === "exa",
  );
  if (exaSpecs.length === 0) {
    return { async close() {} };
  }
  const mcp = await (options.connectMcpClient ?? connectDeepResearchMcpClient)(exaSpecs[0]!);
  const tools = await listDeepResearchMcpTools(mcp);
  const client = createExaMcpClientFromDirectClient(mcp, tools);
  if (!client) {
    await mcp.close();
    return { async close() {} };
  }
  return {
    client,
    async close() {
      await mcp.close();
    },
  };
}

export function createExaMcpClientFromDirectClient(
  mcp: DeepResearchDirectMcpClient,
  tools: DeepResearchDirectMcpTool[],
): DeepResearchExaMcpClient | undefined {
  const searchToolName = findMcpToolCallName(tools, ["web_search_exa", "mcp__exa__web_search_exa"]);
  if (!searchToolName) {
    return undefined;
  }
  const fetchToolName = findMcpToolCallName(tools, ["web_fetch_exa", "mcp__exa__web_fetch_exa"]);
  return {
    async web_search_exa(args) {
      return callDeepResearchMcpTool(mcp, searchToolName, args);
    },
    ...(fetchToolName
      ? {
          async web_fetch_exa(args: { url: string }) {
            return callDeepResearchMcpTool(mcp, fetchToolName, args);
          },
        }
      : {}),
  };
}

export function createDeepResearchHarnessRegistry(
  options: DeepResearchHarnessOptions = {},
): HarnessRegistry {
  const config = normalizeDeepResearchConfig(options.config);
  const baml = options.baml ?? createLiveDeepResearchBamlClientImpl();
  const providers = resolveProviderClients(options);
  const registry = createStaticHarnessRegistry();

  const researchAdapter: HarnessAdapter = Object.assign(
    async (
      node: RuntimeWorkflowNode,
      context: WorkflowExecutionContext,
    ): Promise<HarnessExecutionResult> => {
      const step = readDeepResearchStep(node);
      if (step === "generate-questions") {
        const nodeConfig = readNodeConfig(node, config);
        const deepResearchRunId = readDeepResearchRunId(node);
        const objective = readNodeObjective(node, context);
        const priorState = buildPriorState(context, deepResearchRunId);
        const questionSet = await baml.GenerateResearchQuestions(objective, priorState, nodeConfig);
        return {
          status: "passed",
          output: `Generated ${questionSet.questions.length} research question(s) for iteration ${questionSet.iteration}.`,
          payload: {
            ...deepResearchRunPayload(deepResearchRunId),
            deepResearchQuestionSet: questionSet,
            deepResearchConfig: nodeConfig,
          },
          execution: executionMetadata(WorkflowHarnessKind.RESEARCH, [
            bamlCall(
              "GenerateResearchQuestions",
              "gpt-5.5",
              buildGenerateQuestionsPromptPreview(objective, priorState, nodeConfig),
            ),
          ]),
        };
      }

      if (step === "provider-research") {
        const provider = readRequiredString(node.input, "provider");
        const iteration = readRequiredNumber(node.input, "iteration");
        const questions = readQuestions(node.input);
        const queries = readStringArray(node.input, "queries");
        const maxResultsPerQuestion = readRequiredNumber(node.input, "maxResultsPerQuestion");
        const nodeConfig = readNodeConfig(node, config);
        const providerClient = providers[provider as DeepResearchProvider];
        if (!providerClient) {
          throw new Error(
            `Deep research provider ${provider} is accepted but not implemented/configured for this MVP.`,
          );
        }
        const providerArgs = {
          provider,
          iteration,
          nodeId: node.id,
          deepResearchRunId: readDeepResearchRunId(node),
          questions,
          queries,
          maxResultsPerQuestion,
          objective: readNodeObjective(node, context),
        };
        const providerPrompt = buildProviderExecutionPrompt(providerArgs);
        let providerResult: { evidence: DeepResearchProviderEvidence[]; retryCount: number };
        try {
          providerResult = await searchProviderWithRetries(
            providerClient,
            providerArgs,
            nodeConfig.providerRetryAttempts,
          );
        } catch (error) {
          if (nodeConfig.providers.length <= 1) {
            throw error;
          }
          const retryCount = nodeConfig.providerRetryAttempts;
          const message = errorMessage(error);
          const failure: DeepResearchProviderFailure = {
            provider,
            iteration,
            retryCount,
            message,
            questionIds: questions.map((question) => question.id),
          };
          const retryPhrase =
            retryCount > 0 ? ` after ${retryCount} ${retryCount === 1 ? "retry" : "retries"}` : "";
          return {
            status: "passed",
            output: [
              `${provider} failed${retryPhrase}; continuing with 0 normalized source result(s) from this provider.`,
              `Other configured providers may still satisfy the research iteration.`,
              `Error: ${clipWhitespace(message, 500)}`,
            ].join(" "),
            payload: {
              ...deepResearchRunPayload(readDeepResearchRunId(node)),
              deepResearchEvidence: [],
              deepResearchProviderFailures: [failure],
            },
            execution: executionMetadata(WorkflowHarnessKind.RESEARCH, [
              {
                executor: provider,
                operation: "search",
                mode: "research",
                prompt: providerPrompt,
                model: providerNodeModel(provider).model,
              },
            ]),
          };
        }
        const evidence = providerResult.evidence.map((item, index) =>
          normalizeEvidence(item, provider, iteration, index),
        );
        const retrySuffix =
          providerResult.retryCount > 0
            ? ` after ${providerResult.retryCount} ${providerResult.retryCount === 1 ? "retry" : "retries"}`
            : "";
        return {
          status: "passed",
          output: `${provider} returned ${evidence.length} normalized source result(s)${retrySuffix}.`,
          payload: {
            ...deepResearchRunPayload(readDeepResearchRunId(node)),
            deepResearchEvidence: evidence,
          },
          execution: executionMetadata(WorkflowHarnessKind.RESEARCH, [
            {
              executor: provider,
              operation: "search",
              mode: "research",
              prompt: providerPrompt,
              model: providerNodeModel(provider).model,
            },
          ]),
        };
      }

      if (step === "assess-iteration") {
        const iteration = readRequiredNumber(node.input, "iteration");
        const deepResearchRunId = readDeepResearchRunId(node);
        const questionSet = getPayloadValue<ResearchQuestionSet>(
          context,
          readRequiredString(node.input, "questionNodeId"),
          "deepResearchQuestionSet",
        );
        const providerNodeIds = readProviderNodeIds(node.input);
        const evidence = providerNodeIds.flatMap((nodeId) =>
          getPayloadValue<DeepResearchEvidence[]>(context, nodeId, "deepResearchEvidence"),
        );
        const providerFailures = providerNodeIds.flatMap((nodeId) =>
          getOptionalPayloadArray<DeepResearchProviderFailure>(
            context,
            nodeId,
            "deepResearchProviderFailures",
          ).filter(isDeepResearchProviderFailure),
        );
        if (evidence.length === 0 && providerFailures.length > 0) {
          throw new Error(
            [
              `All provider research failed for iteration ${iteration}; cannot assess evidence coverage.`,
              ...providerFailures.map(
                (failure) => `${failure.provider}: ${clipWhitespace(failure.message, 220)}`,
              ),
            ].join(" "),
          );
        }
        const priorState = buildPriorState(context, deepResearchRunId);
        const assessment = await baml.AssessResearchIteration(questionSet, evidence, priorState);
        const prompt = buildAssessIterationPromptPreview(questionSet, evidence, priorState);
        return {
          status: "passed",
          output: assessment.answerSufficient
            ? `Research iteration ${iteration} is sufficient: ${assessment.stopReason}`
            : `Research iteration ${iteration} needs follow-up: ${assessment.stopReason}`,
          payload: {
            ...deepResearchRunPayload(deepResearchRunId),
            deepResearchAssessment: assessment,
            deepResearchConfig: readNodeConfig(node, config),
          },
          execution: executionMetadata(WorkflowHarnessKind.RESEARCH, [
            bamlCall("AssessResearchIteration", "gpt-5.5", prompt),
          ]),
        };
      }

      return {
        status: "passed",
        output: `Deep research harness skipped unsupported node ${node.id}.`,
      };
    },
    {
      prepareExecution(node: RuntimeWorkflowNode, context: WorkflowExecutionContext) {
        return prepareDeepResearchResearchExecution(node, context, config);
      },
    },
  );

  const reporterAdapter: HarnessAdapter = async (node, context) => {
    const step = readDeepResearchStep(node);
    if (step !== "compile-report") {
      return {
        status: "passed",
        output: `Deep research reporter skipped unsupported node ${node.id}.`,
      };
    }
    const deepResearchRunId = readDeepResearchRunId(node);
    const finalState = buildPriorState(context, deepResearchRunId);
    const objective = readNodeObjective(node, context);
    let report: DeepResearchReport;
    let compilerError: string | undefined;
    try {
      const compiled = await baml.CompileDeepResearchReport(
        objective,
        compactReportInputState(finalState),
      );
      report = buildDeepResearchReportWithMarkdown(
        objective,
        finalState,
        validateCompiledReportMarkdown(compiled.markdown),
      );
    } catch (error) {
      compilerError = errorMessage(error);
      report = buildFallbackDeepResearchReport(objective, finalState, error);
    }
    const artifacts = await persistReportMarkdown(context.outputDir, report, deepResearchRunId);
    return {
      status: compilerError ? "failed" : "passed",
      output: report.markdown,
      error: compilerError,
      payload: { ...deepResearchRunPayload(deepResearchRunId), deepResearchReport: report },
      artifacts,
      execution: executionMetadata(WorkflowHarnessKind.REPORTER, [
        bamlCall("CompileDeepResearchReport", "claude-opus-4.8"),
      ]),
    };
  };

  const copilotAdapter: HarnessAdapter = async (node, context) => {
    const step = readDeepResearchStep(node);
    if (step !== "visualize-report") {
      return {
        status: "passed",
        output: `Deep research Copilot harness skipped unsupported node ${node.id}.`,
      };
    }
    const reportNodeId =
      readOptionalStringValue(node.input, "reportNodeId") ??
      deepResearchNodeId(readDeepResearchRunId(node), "report");
    const report = getPayloadValue<DeepResearchReport>(context, reportNodeId, "deepResearchReport");
    const prompt = buildVisualPlanPrompt(report);
    if (!options.copilot) {
      return {
        status: "passed",
        output: "Deep research visual-plan skipped because no Copilot client is configured.",
        payload: { deepResearchVisualPlan: { skipped: true, reason: "missing-copilot-client" } },
      };
    }
    const rawVisualPlan = await options.copilot.run({
      prompt,
      mode: "plan",
      model: "claude-opus-4.8",
      operation: node.id,
      nodeId: node.id,
      label: "Copilot deep research visual-plan",
    });
    return {
      status: "passed",
      output: rawVisualPlan,
      payload: { deepResearchVisualPlan: { rawVisualPlan } },
      execution: executionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
        {
          executor: "copilot-sdk",
          operation: node.id,
          mode: "plan",
          prompt,
          model: "claude-opus-4.8",
          capabilityScope: "skill:visual-plan",
        },
      ]),
    };
  };

  registry.set(WorkflowHarnessKind.RESEARCH, researchAdapter);
  registry.set(WorkflowHarnessKind.REPORTER, reporterAdapter);
  registry.set(WorkflowHarnessKind.COPILOT_SDK, copilotAdapter);
  return registry;
}

export function createDeepResearchDynamicExpander(): WorkflowDynamicExpander {
  return ({ node, result }) => {
    if (result.status !== "passed") {
      return undefined;
    }
    const step = readDeepResearchStep(node);
    if (step === "generate-questions") {
      const questionSet = result.payload?.deepResearchQuestionSet as
        | ResearchQuestionSet
        | undefined;
      if (!questionSet) {
        return undefined;
      }
      const config = readNodeConfig(node);
      const iteration = readRequiredNumber(node.input, "iteration");
      const deepResearchRunId = readDeepResearchRunId(node);
      const objective = readNodeObjective(node);
      const providerNodes = config.providers.flatMap((provider) => {
        const questions = questionsForProvider(provider, config.providers, questionSet.questions);
        if (questions.length === 0) {
          return [];
        }
        return [
          buildProviderNode({
            provider,
            iteration,
            questions,
            config,
            questionNodeId: node.id,
            deepResearchRunId,
            objective,
          }),
        ];
      });
      return [
        ...providerNodes,
        buildAssessmentNode({
          iteration,
          config,
          questionNodeId: node.id,
          providerNodeIds: providerNodes.map((providerNode) => providerNode.id),
          deepResearchRunId,
          objective,
        }),
      ];
    }

    if (step === "assess-iteration") {
      const assessment = result.payload?.deepResearchAssessment as
        | ResearchIterationAssessment
        | undefined;
      if (!assessment) {
        return undefined;
      }
      const config = readNodeConfig(node);
      const iteration = readRequiredNumber(node.input, "iteration");
      const deepResearchRunId = readDeepResearchRunId(node);
      const objective = readNodeObjective(node);
      if (assessment.answerSufficient || iteration >= config.maxIterations) {
        const report = buildReportNode(node.id, deepResearchRunId, objective);
        return config.visualize ? [report, buildVisualizationNode(report.id)] : [report];
      }
      return [buildQuestionNode(iteration + 1, config, node.id, deepResearchRunId, objective)];
    }

    return undefined;
  };
}

export function normalizeDeepResearchConfig(
  config: Partial<DeepResearchDefaults> | DeepResearchConfig | undefined,
): DeepResearchConfig {
  return {
    providers: config?.providers?.length
      ? config.providers
      : DEFAULT_DEEP_RESEARCH_CONFIG.providers,
    maxIterations: positiveIntegerOr(
      config?.maxIterations,
      DEFAULT_DEEP_RESEARCH_CONFIG.maxIterations,
    ),
    questionsPerIteration: positiveIntegerOr(
      config?.questionsPerIteration,
      DEFAULT_DEEP_RESEARCH_CONFIG.questionsPerIteration,
    ),
    maxResultsPerQuestion: positiveIntegerOr(
      config?.maxResultsPerQuestion,
      DEFAULT_DEEP_RESEARCH_CONFIG.maxResultsPerQuestion,
    ),
    providerRetryAttempts: nonNegativeIntegerOr(
      config?.providerRetryAttempts,
      DEFAULT_DEEP_RESEARCH_CONFIG.providerRetryAttempts,
    ),
    visualize: config?.visualize ?? DEFAULT_DEEP_RESEARCH_CONFIG.visualize,
  };
}

export function deepResearchNodeId(deepResearchRunId: string | undefined, suffix: string): string {
  return deepResearchRunId ? `${deepResearchRunId}-${suffix}` : `deep-research-${suffix}`;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function resolveProviderClients(
  options: DeepResearchHarnessOptions,
): Partial<Record<DeepResearchProvider, DeepResearchProviderClient>> {
  return {
    [DeepResearchProvider.EXA]:
      options.providers?.exa ?? (options.exaMcp ? createExaMcpProvider(options.exaMcp) : undefined),
    [DeepResearchProvider.GROK]: options.providers?.grok ?? createGrokCliProvider(options.grok),
    [DeepResearchProvider.TAVILY]: options.providers?.tavily,
    [DeepResearchProvider.PERPLEXITY]: options.providers?.perplexity,
    [DeepResearchProvider.COPILOT_LAST30DAYS]:
      options.providers?.[DeepResearchProvider.COPILOT_LAST30DAYS] ??
      createCopilotLast30DaysProvider({
        copilot: options.copilot,
        tooling: options.tooling,
        cwd: options.cwd ?? process.cwd(),
        homeDirectory: options.homeDirectory,
      }),
  };
}

async function searchProviderWithRetries(
  providerClient: DeepResearchProviderClient,
  args: DeepResearchProviderSearchArgs,
  retryAttempts: number,
): Promise<{ evidence: DeepResearchProviderEvidence[]; retryCount: number }> {
  const maxAttempts = 1 + Math.max(0, retryAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return {
        evidence: await providerClient.search(args),
        retryCount: attempt - 1,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function findMcpTool(
  tools: DeepResearchMcpTool[],
  names: string[],
): DeepResearchMcpTool | undefined {
  return tools.find((tool) => names.includes(tool.name));
}

async function connectDeepResearchMcpClient(
  spec: RemoteFlueMcpSpec,
): Promise<DeepResearchDirectMcpClient> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({
    name: "weavekit-deep-research",
    version: "0.0.0",
  });
  const requestInit = spec.headers ? { headers: spec.headers } : undefined;
  const url = new URL(spec.url);
  const mcpTransport =
    spec.transport === "sse"
      ? new (await import("@modelcontextprotocol/sdk/client/sse.js")).SSEClientTransport(url, {
          requestInit,
        })
      : new (
          await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
        ).StreamableHTTPClientTransport(url, { requestInit });
  try {
    await client.connect(mcpTransport);
    return client as DeepResearchDirectMcpClient;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function listDeepResearchMcpTools(
  mcp: DeepResearchDirectMcpClient,
): Promise<DeepResearchDirectMcpTool[]> {
  const tools: DeepResearchDirectMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await mcp.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(
        `[weavekit] MCP server repeated tools/list cursor ${JSON.stringify(cursor)} during Exa tool discovery.`,
      );
    }
    if (cursor) {
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

function findMcpToolCallName(
  tools: DeepResearchDirectMcpTool[],
  names: string[],
): string | undefined {
  const tool = tools.find((item) => names.includes(item.name));
  if (!tool) {
    return undefined;
  }
  return tool.name.startsWith("mcp__exa__") ? tool.name.slice("mcp__exa__".length) : tool.name;
}

async function callDeepResearchMcpTool(
  mcp: DeepResearchDirectMcpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp.callTool({ name, arguments: args });
  return normalizeMcpToolResult(result);
}

function normalizeMcpToolResult(result: unknown): unknown {
  const record = asRecord(result);
  if (record.isError === true) {
    throw new Error(readMcpTextContent(record) ?? "MCP tool returned an error.");
  }
  if (record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  const text = readMcpTextContent(record);
  if (text !== undefined) {
    return parseJsonOrContent(text);
  }
  return result;
}

function readMcpTextContent(record: Record<string, unknown>): string | undefined {
  const content = record.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((item) => {
      const itemRecord = asRecord(item);
      return itemRecord.type === "text" && typeof itemRecord.text === "string"
        ? [itemRecord.text]
        : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function parseJsonOrContent(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

function createExaMcpProvider(exa: DeepResearchExaMcpClient): DeepResearchProviderClient {
  return {
    async search(args) {
      const evidence: DeepResearchProviderEvidence[] = [];
      for (const [questionIndex, question] of args.questions.entries()) {
        const queries = question.searchQueries.length > 0 ? question.searchQueries : args.queries;
        for (const query of queries.slice(0, args.maxResultsPerQuestion)) {
          const searchResult = await exa.web_search_exa({
            query,
            numResults: args.maxResultsPerQuestion,
          });
          evidence.push(
            ...(await fetchExaResultContent(
              exa,
              normalizeExaSearchResult(searchResult, question.id, query, questionIndex),
            )),
          );
        }
      }
      return evidence.slice(0, args.questions.length * args.maxResultsPerQuestion);
    },
  };
}

async function fetchExaResultContent(
  exa: DeepResearchExaMcpClient,
  evidence: DeepResearchProviderEvidence[],
): Promise<DeepResearchProviderEvidence[]> {
  if (!exa.web_fetch_exa) {
    return evidence;
  }
  return Promise.all(
    evidence.map(async (item) => {
      if (!item.url || item.content) {
        return item;
      }
      try {
        const fetched = await exa.web_fetch_exa?.({ url: item.url });
        const record = asRecord(fetched);
        return {
          ...item,
          content:
            readOptionalString(record.content) ?? readOptionalString(record.text) ?? item.content,
          provenance: `${item.provenance}; web_fetch_exa`,
        };
      } catch {
        return item;
      }
    }),
  );
}

function normalizeExaSearchResult(
  searchResult: unknown,
  questionId: string,
  query: string,
  questionIndex: number,
): DeepResearchProviderEvidence[] {
  const searchRecord = asRecord(searchResult);
  const content = readOptionalString(searchRecord.content);
  if (content && !searchRecord.url && !searchRecord.title && !searchRecord.results) {
    return parseExaTextSearchResults(content, questionId, query, questionIndex);
  }
  const results = Array.isArray(searchResult)
    ? searchResult
    : Array.isArray(searchRecord.results)
      ? searchRecord.results
      : [searchResult];
  return results.map((raw, index) => {
    const record = asRecord(raw);
    return {
      provider: DeepResearchProvider.EXA,
      questionId,
      query,
      url: readOptionalString(record.url),
      title: readOptionalString(record.title),
      excerpt: readOptionalString(record.text) ?? readOptionalString(record.snippet),
      content: readOptionalString(record.content),
      sourceQuality: "unknown",
      provenance: `exa mcp web_search_exa result ${questionIndex + 1}.${index + 1}`,
    };
  });
}

function parseExaTextSearchResults(
  content: string,
  questionId: string,
  query: string,
  questionIndex: number,
): DeepResearchProviderEvidence[] {
  const blocks = content
    .split(/\n(?=Title:\s*)/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const parsed = blocks.flatMap((block, index) => {
    const title = block.match(/^Title:\s*(.+)$/mu)?.[1]?.trim();
    const url = block.match(/^URL:\s*(.+)$/mu)?.[1]?.trim();
    if (!title && !url) {
      return [];
    }
    const highlights = block.match(/^Highlights:\s*([\s\S]*)$/mu)?.[1]?.trim();
    return [
      {
        provider: DeepResearchProvider.EXA,
        questionId,
        query,
        url,
        title,
        excerpt: highlights ? clipWhitespace(highlights, 1_000) : undefined,
        content: block,
        sourceQuality: "unknown",
        provenance: `exa mcp web_search_exa text result ${questionIndex + 1}.${index + 1}`,
      },
    ];
  });
  return parsed.length > 0
    ? parsed
    : [
        {
          provider: DeepResearchProvider.EXA,
          questionId,
          query,
          content,
          sourceQuality: "unknown",
          provenance: `exa mcp web_search_exa text result ${questionIndex + 1}.1`,
        },
      ];
}

function createGrokCliProvider(
  options: DeepResearchHarnessOptions["grok"] = {},
): DeepResearchProviderClient {
  const command = options.command ?? "grok";
  const timeoutMs = options.timeoutMs ?? 300_000;
  return {
    async search(args) {
      const prompt = buildGrokProviderPrompt(args);
      const { stdout } = await execFileAsync(command, ["-p", prompt, "--output-format", "plain"], {
        timeout: timeoutMs,
      });
      const content = stdout.trim();
      if (!content) {
        throw new Error("grok returned empty deep-research output.");
      }
      return args.questions.map((question, index) => ({
        provider: DeepResearchProvider.GROK,
        questionId: question.id,
        query: args.queries[index] ?? args.queries[0] ?? question.text,
        title: `Grok research for ${question.id}`,
        excerpt: content.slice(0, 800),
        content,
        sourceQuality: "unknown",
        provenance: "grok cli with x_search",
      }));
    },
  };
}

function prepareDeepResearchResearchExecution(
  node: RuntimeWorkflowNode,
  context: WorkflowExecutionContext,
  fallbackConfig: DeepResearchConfig,
): WorkflowExecutionMetadata | undefined {
  const step = readDeepResearchStep(node);
  if (step === "generate-questions") {
    const nodeConfig = readNodeConfig(node, fallbackConfig);
    const deepResearchRunId = readDeepResearchRunId(node);
    const objective = readNodeObjective(node, context);
    const priorState = buildPriorState(context, deepResearchRunId);
    return executionMetadata(WorkflowHarnessKind.RESEARCH, [
      bamlCall(
        "GenerateResearchQuestions",
        "gpt-5.5",
        buildGenerateQuestionsPromptPreview(objective, priorState, nodeConfig),
      ),
    ]);
  }
  if (step === "provider-research") {
    const provider = readRequiredString(node.input, "provider");
    const args = {
      provider,
      iteration: readRequiredNumber(node.input, "iteration"),
      nodeId: node.id,
      deepResearchRunId: readDeepResearchRunId(node),
      questions: readQuestions(node.input),
      queries: readStringArray(node.input, "queries"),
      maxResultsPerQuestion: readRequiredNumber(node.input, "maxResultsPerQuestion"),
      objective: readNodeObjective(node, context),
    };
    return executionMetadata(WorkflowHarnessKind.RESEARCH, [
      {
        executor: provider,
        operation: "search",
        mode: "research",
        prompt: buildProviderExecutionPrompt(args),
        model: providerNodeModel(provider).model,
      },
    ]);
  }
  if (step === "assess-iteration") {
    const deepResearchRunId = readDeepResearchRunId(node);
    const questionSet = getPayloadValue<ResearchQuestionSet>(
      context,
      readRequiredString(node.input, "questionNodeId"),
      "deepResearchQuestionSet",
    );
    const providerNodeIds = readProviderNodeIds(node.input);
    const evidence = providerNodeIds.flatMap((nodeId) =>
      getPayloadValue<DeepResearchEvidence[]>(context, nodeId, "deepResearchEvidence"),
    );
    const priorState = buildPriorState(context, deepResearchRunId);
    return executionMetadata(WorkflowHarnessKind.RESEARCH, [
      bamlCall(
        "AssessResearchIteration",
        "gpt-5.5",
        buildAssessIterationPromptPreview(questionSet, evidence, priorState),
      ),
    ]);
  }
  return undefined;
}

function buildProviderExecutionPrompt(args: {
  provider: string;
  objective: string;
  questions: DeepResearchQuestion[];
  queries: string[];
  maxResultsPerQuestion: number;
}): string {
  if (args.provider === DeepResearchProvider.GROK) {
    return buildGrokProviderPrompt(args);
  }
  if (args.provider === DeepResearchProvider.COPILOT_LAST30DAYS) {
    return buildCopilotLast30DaysPrompt(args);
  }
  if (args.provider === DeepResearchProvider.EXA) {
    return buildExaProviderPrompt(args);
  }
  return [
    `Provider: ${args.provider}`,
    `Objective: ${args.objective}`,
    `Provider result limit per question: ${args.maxResultsPerQuestion}`,
    "",
    "Questions:",
    ...args.questions.map((question) => `- ${question.id}: ${question.text}`),
    "",
    "Queries:",
    ...args.queries.map((query) => `- ${query}`),
  ].join("\n");
}

function buildGrokProviderPrompt(args: {
  objective: string;
  questions: DeepResearchQuestion[];
  queries: string[];
  maxResultsPerQuestion: number;
}): string {
  return [
    "Use x_search for each query below. Return concise markdown with URLs, titles, and excerpts.",
    `Objective: ${args.objective}`,
    `Provider result limit per question: ${args.maxResultsPerQuestion}`,
    "",
    "Questions:",
    ...args.questions.map((question) => `- ${question.id}: ${question.text}`),
    "",
    "Queries:",
    ...args.queries.map((query) => `- ${query}`),
  ].join("\n");
}

function buildExaProviderPrompt(args: {
  objective: string;
  questions: DeepResearchQuestion[];
  queries: string[];
  maxResultsPerQuestion: number;
}): string {
  return [
    "Run Exa web search for each question/query pair below.",
    `Objective: ${args.objective}`,
    `Provider result limit per question: ${args.maxResultsPerQuestion}`,
    "",
    "Questions:",
    ...args.questions.map((question) =>
      [
        `- ${question.id}: ${question.text}`,
        question.searchQueries.length > 0
          ? `  Search queries: ${question.searchQueries.join("; ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "All provider-node search queries:",
    ...args.queries.map((query) => `- ${query}`),
  ].join("\n");
}

function buildGenerateQuestionsPromptPreview(
  objective: string,
  priorState: DeepResearchPriorState,
  config: DeepResearchConfig,
): string {
  return [
    "Generate bounded deep-research questions for an iterative, in-process workflow.",
    "Use stable ids. Prefer concrete search queries that can be sent to Exa, Grok, and Copilot last30days.",
    "Set researchMode for every question:",
    "- local-only: repository-evidence or gap-existence questions that should not call external providers.",
    "- official-docs: setup, API syntax, configuration, install, command semantics, or how-to usage questions.",
    "- web-lookup: lightweight current web/documentation lookup that does not require expensive synthesis.",
    "- recency-social: recent issues, recent community sentiment, last-30-days reports, X/social/forum signals.",
    "- deep-research: open-ended framework choices, tradeoffs, risks, rollout strategy, cost controls, or disputed recommendations.",
    "Use researchModeRationale to explain the cost/coverage tradeoff in one short sentence.",
    "Respect questionsPerIteration and provider hints. Do not repeat completed questions.",
    "",
    "Research prompt:",
    objective,
    "",
    "Prior state:",
    JSON.stringify(priorState, null, 2),
    "",
    "Config:",
    JSON.stringify(config, null, 2),
  ].join("\n");
}

function buildAssessIterationPromptPreview(
  questionSet: ResearchQuestionSet,
  evidence: DeepResearchEvidence[],
  priorState: DeepResearchPriorState,
): string {
  return [
    "Assess evidence coverage for this research iteration. Identify contradictions and gaps.",
    "Set answerSufficient true only when the evidence can support a useful cited report for the original objective.",
    "If more research is useful, emit focused follow-up questions.",
    "",
    "Question set:",
    JSON.stringify(questionSet, null, 2),
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2),
    "",
    "Prior state:",
    JSON.stringify(priorState, null, 2),
  ].join("\n");
}

function createCopilotLast30DaysProvider(options: {
  copilot?: DeepResearchCopilotClient;
  tooling?: ToolingDefaults;
  cwd: string;
  homeDirectory?: string;
}): DeepResearchProviderClient {
  return {
    async search(args) {
      if (!options.copilot) {
        throw new Error(
          [
            "Deep research provider copilot-last30days requires a Copilot SDK client configured.",
            "In CLI runs this is created automatically from [copilot] config; programmatic callers should pass options.copilot.",
          ].join(" "),
        );
      }
      const capabilityScope = last30DaysSkillCapabilityScope(
        options.cwd,
        options.tooling,
        options.homeDirectory,
      );
      const prompt = buildCopilotLast30DaysPrompt(args);
      const content = await options.copilot.run({
        prompt,
        mode: "research",
        model: DEFAULT_COPILOT_LAST30DAYS_MODEL,
        maxToolCalls: DEFAULT_COPILOT_LAST30DAYS_MAX_TOOL_CALLS,
        operation:
          args.nodeId ??
          `deep-research-${DeepResearchProvider.COPILOT_LAST30DAYS}-${args.iteration}`,
        nodeId:
          args.nodeId ??
          `deep-research-${DeepResearchProvider.COPILOT_LAST30DAYS}-${args.iteration}`,
        label: "Copilot last30days deep research",
        capabilityScope,
      });
      const normalizedContent = content.trim();
      if (!normalizedContent) {
        throw new Error("Copilot SDK returned empty last30days deep-research output.");
      }
      return args.questions.map((question, index) => ({
        provider: DeepResearchProvider.COPILOT_LAST30DAYS,
        questionId: question.id,
        query: question.searchQueries[0] ?? args.queries[index] ?? args.queries[0] ?? question.text,
        title: `last30days research for ${question.id}`,
        excerpt: normalizedContent.slice(0, 800),
        content: normalizedContent,
        sourceQuality: "community",
        provenance: "copilot sdk with last30days skill",
      }));
    },
  };
}

function buildCopilotLast30DaysPrompt(args: {
  objective: string;
  questions: DeepResearchQuestion[];
  queries: string[];
  maxResultsPerQuestion: number;
}): string {
  return [
    "/last30days Research recent community and web discussion from the last 30 days for this deep-research provider node.",
    "",
    `Objective: ${args.objective}`,
    `Provider result limit per question: ${args.maxResultsPerQuestion}`,
    "",
    "Return a concise synthesis with concrete source names, URLs when available, disagreement, recency signals, and confidence limits.",
    "",
    "Questions:",
    ...args.questions.map((question) =>
      [
        `- ${question.id}: ${question.text}`,
        question.searchQueries.length > 0
          ? `  Search queries: ${question.searchQueries.join("; ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "All provider-node search queries:",
    ...args.queries.map((query) => `- ${query}`),
  ].join("\n");
}

function last30DaysSkillCapabilityScope(
  cwd: string,
  tooling?: ToolingDefaults,
  homeDirectory = homedir(),
): CopilotCapabilityScope {
  const skillName = "last30days";
  const skillDirectory = resolveRequiredSkillDiscoveryDirectory(
    skillName,
    cwd,
    tooling,
    homeDirectory,
  );
  return {
    kind: "skill",
    skillName,
    skillDirectories: [skillDirectory],
    disabledSkills: siblingSkillNames(skillDirectory).filter((name) => name !== skillName),
  };
}

function resolveRequiredSkillDiscoveryDirectory(
  skillName: string,
  cwd: string,
  tooling: ToolingDefaults | undefined,
  homeDirectory: string,
): string {
  const candidates = uniqueStrings(
    [
      tooling?.skillsDirectory,
      join(cwd, ".agents", "skills"),
      join(cwd, ".copilot", "skills"),
      join(homeDirectory, ".agents", "skills"),
      join(homeDirectory, ".copilot", "skills"),
      join(homeDirectory, ".codex", "skills"),
    ].filter((value): value is string => Boolean(value)),
  );
  const found = candidates.find((directory) => existsSync(join(directory, skillName, "SKILL.md")));
  if (found) {
    return found;
  }
  throw new Error(
    [
      `Deep research provider copilot-last30days requires the ${skillName} skill, but no ${join(skillName, "SKILL.md")} was found in configured skill directories.`,
      `Checked: ${candidates.join(", ")}.`,
      "Install it with `nubx skills add mvanhorn/last30days-skill -g`.",
    ].join(" "),
  );
}

function siblingSkillNames(skillDirectory: string): string[] {
  if (!existsSync(skillDirectory)) {
    return [];
  }
  return readdirSync(skillDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readDeepResearchStep(node: RuntimeWorkflowNode): DeepResearchStep | undefined {
  const step = node.input?.deepResearchStep;
  return typeof step === "string" ? (step as DeepResearchStep) : undefined;
}

function readDeepResearchRunId(node: RuntimeWorkflowNode): string | undefined {
  return readOptionalStringValue(node.input, "deepResearchRunId");
}

function readNodeObjective(node: RuntimeWorkflowNode, context?: WorkflowExecutionContext): string {
  return readOptionalStringValue(node.input, "objective") ?? context?.objective ?? node.prompt;
}

function deepResearchRunPayload(deepResearchRunId: string | undefined): WorkflowNodePayload {
  return deepResearchRunId ? { deepResearchRunId } : {};
}

function readNodeConfig(
  node: RuntimeWorkflowNode,
  fallback: DeepResearchConfig = DEFAULT_DEEP_RESEARCH_CONFIG,
): DeepResearchConfig {
  return normalizeDeepResearchConfig(
    (node.input?.config as Partial<DeepResearchDefaults> | undefined) ?? fallback,
  );
}

function questionsForProvider(
  provider: string,
  configuredProviders: string[],
  questions: DeepResearchQuestion[],
): DeepResearchQuestion[] {
  return questions.filter((question) =>
    providersForQuestion(question, configuredProviders).includes(provider),
  );
}

function providersForQuestion(
  question: DeepResearchQuestion,
  configuredProviders: string[],
): string[] {
  const mode = readQuestionResearchMode(question);
  if (mode) {
    return configuredProviders.filter((provider) =>
      providersForResearchMode(mode).includes(provider),
    );
  }
  const providerHints = question.providerHints.filter((provider) =>
    configuredProviders.includes(provider),
  );
  return providerHints.length > 0 ? providerHints : configuredProviders;
}

function providersForResearchMode(mode: DeepResearchMode): string[] {
  if (mode === DeepResearchMode.LOCAL_ONLY) {
    return [];
  }
  if (mode === DeepResearchMode.OFFICIAL_DOCS || mode === DeepResearchMode.WEB_LOOKUP) {
    return [DeepResearchProvider.EXA];
  }
  if (mode === DeepResearchMode.RECENCY_SOCIAL) {
    return [DeepResearchProvider.GROK, DeepResearchProvider.COPILOT_LAST30DAYS];
  }
  return [
    DeepResearchProvider.GROK,
    DeepResearchProvider.EXA,
    DeepResearchProvider.COPILOT_LAST30DAYS,
    DeepResearchProvider.TAVILY,
    DeepResearchProvider.PERPLEXITY,
  ];
}

function readQuestionResearchMode(question: DeepResearchQuestion): DeepResearchMode | undefined {
  const value = (question as DeepResearchQuestion & { researchMode?: unknown }).researchMode;
  return isDeepResearchMode(value) ? value : undefined;
}

function isDeepResearchMode(value: unknown): value is DeepResearchMode {
  return (
    value === DeepResearchMode.LOCAL_ONLY ||
    value === DeepResearchMode.OFFICIAL_DOCS ||
    value === DeepResearchMode.WEB_LOOKUP ||
    value === DeepResearchMode.RECENCY_SOCIAL ||
    value === DeepResearchMode.DEEP_RESEARCH
  );
}

export function buildDeepResearchSeedQuestionNode(args: {
  deepResearchRunId?: string;
  objective: string;
  config: DeepResearchConfig;
  dependsOn?: string[];
}): RuntimeWorkflowNode {
  return {
    id: deepResearchNodeId(args.deepResearchRunId, "questions-1"),
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: "Generate research questions",
    description: "Generate the first bounded question batch for iterative deep research.",
    model: "gpt-5.5",
    modelRationale: "Question generation uses the primary research synthesis model.",
    prompt: "Generate the first research question set for the objective.",
    input: {
      deepResearchStep: "generate-questions",
      ...(args.deepResearchRunId
        ? { deepResearchRunId: args.deepResearchRunId, objective: args.objective }
        : {}),
      iteration: 1,
      config: args.config,
    },
    dependsOn: args.dependsOn ?? [],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildQuestionNode(
  iteration: number,
  config: DeepResearchConfig,
  dependency: string,
  deepResearchRunId: string | undefined,
  objective: string,
): RuntimeWorkflowNode {
  return {
    id: deepResearchNodeId(deepResearchRunId, `questions-${iteration}`),
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: `Generate follow-up questions ${iteration}`,
    description: `Generate follow-up question batch for deep research iteration ${iteration}.`,
    model: "gpt-5.5",
    modelRationale: "Question generation uses the primary research synthesis model.",
    prompt: `Generate deep research follow-up questions for iteration ${iteration}.`,
    input: {
      deepResearchStep: "generate-questions",
      ...deepResearchRunPayload(deepResearchRunId),
      ...(deepResearchRunId ? { objective } : {}),
      iteration,
      config,
    },
    dependsOn: [dependency],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildProviderNode(args: {
  provider: string;
  iteration: number;
  questions: DeepResearchQuestion[];
  config: DeepResearchConfig;
  questionNodeId: string;
  deepResearchRunId?: string;
  objective: string;
}): RuntimeWorkflowNode {
  return {
    id: deepResearchNodeId(args.deepResearchRunId, `${args.provider}-${args.iteration}`),
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: `Research with ${args.provider}`,
    description: `Run read-only ${args.provider} research for iteration ${args.iteration}.`,
    ...providerNodeModel(args.provider),
    prompt: `Run ${args.provider} research for deep research iteration ${args.iteration}.`,
    input: {
      deepResearchStep: "provider-research",
      ...deepResearchRunPayload(args.deepResearchRunId),
      ...(args.deepResearchRunId ? { objective: args.objective } : {}),
      provider: args.provider,
      iteration: args.iteration,
      questions: args.questions,
      queries: uniqueStrings(
        args.questions.flatMap((question) =>
          question.searchQueries.length > 0 ? question.searchQueries : [question.text],
        ),
      ),
      maxResultsPerQuestion: args.config.maxResultsPerQuestion,
      questionNodeId: args.questionNodeId,
      config: args.config,
    },
    dependsOn: [args.questionNodeId],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function providerNodeModel(provider: string): { model: string; modelRationale: string } {
  if (provider === DeepResearchProvider.EXA) {
    return {
      model: DEEP_RESEARCH_PROVIDER_SONNET_MODEL,
      modelRationale: "Exa provider research uses Sonnet for source-query execution and synthesis.",
    };
  }
  if (provider === DeepResearchProvider.COPILOT_LAST30DAYS) {
    return {
      model: DEEP_RESEARCH_PROVIDER_SONNET_MODEL,
      modelRationale:
        "Copilot last30days provider research uses Sonnet for recent-source synthesis.",
    };
  }
  if (provider === DeepResearchProvider.GROK) {
    return {
      model: "grok-default",
      modelRationale: "Grok provider research uses the configured Grok CLI default model.",
    };
  }
  return {
    model: "deterministic",
    modelRationale:
      "Provider research executes configured provider tooling rather than a planner model.",
  };
}

function buildAssessmentNode(args: {
  iteration: number;
  config: DeepResearchConfig;
  questionNodeId: string;
  providerNodeIds: string[];
  deepResearchRunId?: string;
  objective: string;
}): RuntimeWorkflowNode {
  return {
    id: deepResearchNodeId(args.deepResearchRunId, `assess-${args.iteration}`),
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: `Assess research iteration ${args.iteration}`,
    description: `Grade coverage and gaps for deep research iteration ${args.iteration}.`,
    model: "gpt-5.5",
    modelRationale: "Coverage grading uses the primary research synthesis model.",
    prompt: `Assess deep research iteration ${args.iteration}.`,
    input: {
      deepResearchStep: "assess-iteration",
      ...deepResearchRunPayload(args.deepResearchRunId),
      ...(args.deepResearchRunId ? { objective: args.objective } : {}),
      iteration: args.iteration,
      questionNodeId: args.questionNodeId,
      providerNodeIds: args.providerNodeIds,
      config: args.config,
    },
    dependsOn: args.providerNodeIds,
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildReportNode(
  dependency: string,
  deepResearchRunId: string | undefined,
  objective: string,
): RuntimeWorkflowNode {
  return {
    id: deepResearchNodeId(deepResearchRunId, "report"),
    kind: WorkflowNodeKind.REPORT,
    harness: WorkflowHarnessKind.REPORTER,
    title: "Compile deep research report",
    description:
      "Compile the final cited Markdown report from all research evidence and assessments.",
    model: "claude-opus-4.8",
    modelRationale:
      "Final report synthesis uses the strongest available long-form synthesis model.",
    prompt: "Compile the deep research Markdown report.",
    input: {
      deepResearchStep: "compile-report",
      ...deepResearchRunPayload(deepResearchRunId),
      ...(deepResearchRunId ? { objective } : {}),
    },
    dependsOn: [dependency],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildVisualizationNode(reportNodeId: string): RuntimeWorkflowNode {
  const runId = reportNodeId.endsWith("-report")
    ? reportNodeId.slice(0, -"report".length).replace(/-$/u, "")
    : undefined;
  return {
    id: runId && runId !== "deep-research" ? `${runId}-visual-plan` : "deep-research-visual-plan",
    kind: WorkflowNodeKind.VISUALIZATION,
    harness: WorkflowHarnessKind.COPILOT_SDK,
    title: "Visualize deep research report",
    description: "Optionally invoke visual-plan against the completed Markdown report.",
    model: "claude-opus-4.8",
    modelRationale: "Visual report design uses a planning-capable model with visual-plan.",
    prompt: "Create a visual-plan artifact for the deep research report.",
    input: {
      deepResearchStep: "visualize-report",
      ...(runId && runId !== "deep-research" ? { deepResearchRunId: runId } : {}),
      reportNodeId,
    },
    dependsOn: [reportNodeId],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildPriorState(
  context: WorkflowExecutionContext,
  deepResearchRunId?: string,
): DeepResearchPriorState {
  const evidence: DeepResearchEvidence[] = [];
  const assessments: ResearchIterationAssessment[] = [];
  const completedQuestionIds = new Set<string>();

  for (const payload of context.payloads.values()) {
    if (deepResearchRunId && payload.deepResearchRunId !== deepResearchRunId) {
      continue;
    }
    const payloadEvidence = payload.deepResearchEvidence;
    if (Array.isArray(payloadEvidence)) {
      evidence.push(...payloadEvidence.filter(isDeepResearchEvidence));
    }
    const assessment = payload.deepResearchAssessment;
    if (isResearchIterationAssessment(assessment)) {
      assessments.push(assessment);
      for (const coverage of assessment.questionCoverage) {
        if (coverage.coverageScore >= 0.7) {
          completedQuestionIds.add(coverage.questionId);
        }
      }
    }
  }

  return {
    iteration: assessments.reduce((max, assessment) => Math.max(max, assessment.iteration), 0),
    completedQuestionIds: [...completedQuestionIds],
    evidence,
    assessments,
  };
}

function compactReportInputState(finalState: DeepResearchPriorState): DeepResearchPriorState {
  return {
    ...finalState,
    evidence: finalState.evidence.map((item) => ({
      ...item,
      excerpt: item.excerpt
        ? clipWhitespace(item.excerpt, REPORT_INPUT_EXCERPT_LIMIT)
        : item.excerpt,
      content: item.content
        ? clipWhitespace(item.content, REPORT_INPUT_CONTENT_LIMIT)
        : item.content,
    })),
  };
}

type DeepResearchReportMetadata = Omit<DeepResearchReport, "markdown">;

function buildDeepResearchReportWithMarkdown(
  objective: string,
  finalState: DeepResearchPriorState,
  markdown: string,
): DeepResearchReport {
  return {
    ...buildDeterministicDeepResearchReportMetadata(
      objective,
      finalState,
      "Generated questions, searched providers, graded coverage/gaps, and compiled the model-generated Markdown report from the evidence set.",
      "Model-generated Markdown report compiled from collected evidence",
      `The Markdown report is the authoritative human-facing synthesis. ${latestAssessmentSummary(finalState)}`,
    ),
    markdown,
  };
}

function validateCompiledReportMarkdown(markdown: string): string {
  const normalized = markdown.trim();
  if (!normalized) {
    throw new Error("CompileDeepResearchReport returned empty markdown.");
  }
  if (!/^#\s+Deep Research Report\b/mu.test(normalized)) {
    throw new Error(
      "CompileDeepResearchReport returned markdown without the required Markdown report heading.",
    );
  }
  return normalized;
}

function buildDeterministicDeepResearchReportMetadata(
  objective: string,
  finalState: DeepResearchPriorState,
  methodologyDetail: string,
  findingTitle: string,
  findingSummary: string,
): DeepResearchReportMetadata {
  const evidence = finalState.evidence;
  const confidence = estimateFallbackConfidence(finalState);
  return {
    objective,
    methodology: [
      `Ran ${finalState.iteration} bounded deep-research iteration(s).`,
      `Collected ${evidence.length} normalized evidence item(s) from ${uniqueStrings(evidence.map((item) => item.provider)).join(", ") || "configured providers"}.`,
      methodologyDetail,
    ].join(" "),
    findings: [
      {
        title: findingTitle,
        summary: findingSummary,
        evidenceIds: evidence.slice(0, 25).map((item) => item.id),
        confidence,
      },
    ],
    evidenceMatrix: evidence.slice(0, FALLBACK_REPORT_EVIDENCE_MATRIX_LIMIT).map((item) => ({
      questionId: item.questionId,
      evidenceId: item.id,
      relevance:
        item.excerpt || item.content
          ? clipWhitespace(item.excerpt ?? item.content ?? "", 180)
          : "Source collected for this research question.",
      quality: item.sourceQuality,
    })),
    contradictions: collectContradictions(finalState),
    gaps: collectGaps(finalState),
    confidence,
    sources: evidence.map((item) => ({
      id: item.id,
      provider: item.provider,
      url: item.url ?? "",
      title: item.title ?? item.url ?? item.id,
      quality: item.sourceQuality,
    })),
  };
}

function buildFallbackDeepResearchReport(
  objective: string,
  finalState: DeepResearchPriorState,
  error: unknown,
): DeepResearchReport {
  const report = buildDeterministicDeepResearchReportMetadata(
    objective,
    finalState,
    "Generated questions, searched providers, graded coverage/gaps, and compiled this deterministic fallback after the BAML report compiler failed validation.",
    "Research evidence was collected, but deterministic fallback reporting was used",
    `The report compiler failed before returning the required markdown field. This fallback preserves the collected evidence, iteration assessments, contradictions, gaps, and sources for review. ${latestAssessmentSummary(finalState)}`,
  );
  return {
    ...report,
    markdown: renderFallbackDeepResearchMarkdown(report, finalState, error),
  };
}

function collectContradictions(finalState: DeepResearchPriorState): string[] {
  return uniqueStrings(
    finalState.assessments.flatMap((assessment) => [
      ...assessment.contradictions,
      ...assessment.questionCoverage.flatMap((coverage) => coverage.contradictions),
    ]),
  );
}

function collectGaps(finalState: DeepResearchPriorState): string[] {
  return uniqueStrings(
    finalState.assessments.flatMap((assessment) => [
      ...assessment.questionCoverage.flatMap((coverage) => coverage.gaps),
      ...(assessment.answerSufficient ? [] : [assessment.stopReason]),
    ]),
  );
}

function estimateFallbackConfidence(finalState: DeepResearchPriorState): string {
  const coverage = finalState.assessments.flatMap((assessment) =>
    assessment.questionCoverage.map((item) => item.coverageScore),
  );
  if (coverage.length === 0 || finalState.evidence.length === 0) {
    return "low";
  }
  const averageCoverage = coverage.reduce((sum, value) => sum + value, 0) / coverage.length;
  if (averageCoverage >= 0.8) {
    return "high";
  }
  if (averageCoverage >= 0.5) {
    return "medium";
  }
  return "low";
}

function latestAssessmentSummary(finalState: DeepResearchPriorState): string {
  const latest = finalState.assessments.at(-1);
  return latest ? `Latest assessment: ${latest.stopReason}` : "No assessment summary was recorded.";
}

function renderFallbackDeepResearchMarkdown(
  report: DeepResearchReportMetadata,
  finalState: DeepResearchPriorState,
  error: unknown,
): string {
  const evidence = finalState.evidence;
  return [
    "# Deep Research Report",
    "",
    `**Objective:** ${report.objective}`,
    "",
    "## Report Generation Notice",
    "",
    `BAML report compilation failed, so Weavekit generated this deterministic fallback Markdown report from the completed research state. Error: ${clipWhitespace(errorMessage(error), 500)}`,
    "",
    "## Methodology",
    "",
    report.methodology,
    "",
    "## Findings",
    "",
    ...report.findings.flatMap((finding, index) => [
      `### ${index + 1}. ${finding.title}`,
      "",
      finding.summary,
      "",
      `Confidence: ${finding.confidence}`,
      "",
      finding.evidenceIds.length > 0
        ? `Evidence IDs: ${finding.evidenceIds.join(", ")}`
        : "Evidence IDs: none recorded.",
      "",
    ]),
    "## Iteration Assessments",
    "",
    ...(finalState.assessments.length === 0
      ? ["No assessment payloads were recorded.", ""]
      : finalState.assessments.flatMap((assessment) => [
          `### Iteration ${assessment.iteration}`,
          "",
          `Answer sufficient: ${assessment.answerSufficient ? "yes" : "no"}`,
          "",
          assessment.stopReason,
          "",
        ])),
    "## Contradictions And Gaps",
    "",
    report.contradictions.length > 0 ? "### Contradictions" : "No contradictions were recorded.",
    ...(report.contradictions.length > 0
      ? ["", ...renderMarkdownList(report.contradictions), ""]
      : [""]),
    report.gaps.length > 0 ? "### Gaps" : "No gaps were recorded.",
    ...(report.gaps.length > 0 ? ["", ...renderMarkdownList(report.gaps), ""] : [""]),
    "## Evidence Matrix",
    "",
    "| Question | Evidence | Quality | Relevance |",
    "| --- | --- | --- | --- |",
    ...(report.evidenceMatrix.length === 0
      ? ["| n/a | n/a | n/a | No evidence matrix entries were recorded. |"]
      : report.evidenceMatrix.map(
          (entry) =>
            `| ${markdownTableCell(entry.questionId)} | ${markdownTableCell(entry.evidenceId)} | ${markdownTableCell(entry.quality)} | ${markdownTableCell(entry.relevance)} |`,
        )),
    "",
    "## Source Highlights",
    "",
    ...(evidence.length === 0
      ? ["No source evidence was recorded.", ""]
      : evidence
          .slice(0, FALLBACK_REPORT_EVIDENCE_MATRIX_LIMIT)
          .flatMap((item) => [
            `### ${item.id}: ${item.title ?? item.url ?? item.provider}`,
            "",
            `Provider: ${item.provider}; question: ${item.questionId}; quality: ${item.sourceQuality}; provenance: ${item.provenance}`,
            "",
            item.url ? `URL: ${item.url}` : "URL: not recorded",
            "",
            item.excerpt || item.content
              ? clipWhitespace(item.excerpt ?? item.content ?? "", 700)
              : "No excerpt or content was recorded.",
            "",
          ])),
    "## Sources",
    "",
    ...(report.sources.length === 0
      ? ["No source URLs were recorded."]
      : report.sources.map((source) => {
          const title = source.title || source.id;
          const location = source.url ? ` - ${source.url}` : "";
          return `- [${source.id}] ${title}${location} (${source.provider}, ${source.quality})`;
        })),
  ].join("\n");
}

function renderMarkdownList(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeEvidence(
  evidence: DeepResearchProviderEvidence,
  provider: string,
  iteration: number,
  index: number,
): DeepResearchEvidence {
  return {
    id: evidence.id ?? `${provider}-${iteration}-${index + 1}`,
    provider: evidence.provider || provider,
    questionId: evidence.questionId,
    query: evidence.query,
    url: evidence.url,
    title: evidence.title,
    excerpt: evidence.excerpt,
    content: evidence.content,
    sourceQuality: evidence.sourceQuality || "unknown",
    provenance: evidence.provenance || provider,
  };
}

async function persistReportMarkdown(
  outputDir: string | undefined,
  report: DeepResearchReport,
  deepResearchRunId?: string,
): Promise<WorkflowArtifactRef[] | undefined> {
  if (!outputDir) {
    return undefined;
  }
  await mkdir(outputDir, { recursive: true });
  const reportPath = deepResearchRunId
    ? `${deepResearchRunId}-DeepResearchReport.md`
    : DEEP_RESEARCH_REPORT_PATH;
  const path = join(outputDir, reportPath);
  await writeFile(path, report.markdown, "utf8");
  return [
    {
      kind: "markdown",
      path: reportPath,
      description: "Deep research Markdown report.",
    },
  ];
}

function buildVisualPlanPrompt(report: DeepResearchReport): string {
  return [
    "/visual-plan Create a visual review artifact for this deep research report.",
    "",
    "Use the Markdown report below as the source material. Focus on findings, evidence quality, contradictions, gaps, source coverage, and confidence.",
    "",
    report.markdown,
  ].join("\n");
}

function getPayloadValue<T>(context: WorkflowExecutionContext, nodeId: string, key: string): T {
  const payload = context.payloads.get(nodeId);
  const value = payload?.[key];
  if (value === undefined) {
    throw new Error(`Missing ${key} payload from ${nodeId}.`);
  }
  return value as T;
}

function getOptionalPayloadArray<T>(
  context: WorkflowExecutionContext,
  nodeId: string,
  key: string,
): T[] {
  const value = context.payloads.get(nodeId)?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function isDeepResearchProviderFailure(value: unknown): value is DeepResearchProviderFailure {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return (
    typeof record.provider === "string" &&
    typeof record.iteration === "number" &&
    typeof record.retryCount === "number" &&
    typeof record.message === "string"
  );
}

function readRequiredString(input: WorkflowNodePayload | undefined, key: string): string {
  const value = input?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Deep research node input requires string ${key}.`);
  }
  return value;
}

function readOptionalStringValue(
  input: WorkflowNodePayload | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readRequiredNumber(input: WorkflowNodePayload | undefined, key: string): number {
  const value = input?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Deep research node input requires number ${key}.`);
  }
  return value;
}

function readQuestions(input: WorkflowNodePayload | undefined): DeepResearchQuestion[] {
  const questions = input?.questions;
  return Array.isArray(questions) ? (questions as DeepResearchQuestion[]) : [];
}

function readStringArray(input: WorkflowNodePayload | undefined, key: string): string[] {
  const value = input?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readProviderNodeIds(input: WorkflowNodePayload | undefined): string[] {
  return readStringArray(input, "providerNodeIds");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clipWhitespace(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function isDeepResearchEvidence(value: unknown): value is DeepResearchEvidence {
  const record = asRecord(value);
  return (
    typeof record.id === "string" &&
    typeof record.provider === "string" &&
    typeof record.questionId === "string"
  );
}

function isDeepResearchReport(value: unknown): value is DeepResearchReport {
  const record = asRecord(value);
  return (
    typeof record.objective === "string" &&
    typeof record.methodology === "string" &&
    Array.isArray(record.findings) &&
    Array.isArray(record.evidenceMatrix) &&
    Array.isArray(record.contradictions) &&
    Array.isArray(record.gaps) &&
    typeof record.confidence === "string" &&
    Array.isArray(record.sources) &&
    typeof record.markdown === "string"
  );
}

function isResearchIterationAssessment(value: unknown): value is ResearchIterationAssessment {
  const record = asRecord(value);
  return typeof record.iteration === "number" && Array.isArray(record.questionCoverage);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function executionMetadata(
  executor: string,
  calls: WorkflowExecutionCall[],
): WorkflowExecutionMetadata {
  return {
    executor,
    calls,
  };
}

function bamlCall(operation: string, model: string, prompt?: string): WorkflowExecutionCall {
  return {
    executor: "baml",
    operation,
    model,
    prompt,
  };
}
