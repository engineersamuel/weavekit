import { b } from "../../generated/baml_client/index.js";
import type {
  DeepResearchCompiledReport,
  DeepResearchConfig,
  DeepResearchEvidence,
  DeepResearchPriorState,
  ResearchIterationAssessment,
  ResearchQuestionSet,
} from "../../generated/baml_client/index.js";
import type { WorkflowUsageCollector } from "../usage.js";

type BamlClientOverride = {
  client: string;
};

const GENERATE_RESEARCH_QUESTIONS_OPTIONS: BamlClientOverride = { client: "CopilotProxyGpt55" };
const ASSESS_RESEARCH_ITERATION_OPTIONS: BamlClientOverride = { client: "CopilotProxyGpt55" };
const COMPILE_DEEP_RESEARCH_REPORT_OPTIONS: BamlClientOverride = { client: "CopilotProxyClaudeOpus48" };

const DEEP_RESEARCH_METHOD_MODELS = {
  GenerateResearchQuestions: "gpt-5.5",
  AssessResearchIteration: "gpt-5.5",
  CompileDeepResearchReport: "claude-opus-4.8",
} as const;

export type DeepResearchBamlClient = {
  GenerateResearchQuestions(prompt: string, priorState: DeepResearchPriorState, config: DeepResearchConfig, options?: unknown): Promise<ResearchQuestionSet>;
  AssessResearchIteration(questionSet: ResearchQuestionSet, evidence: DeepResearchEvidence[], priorState: DeepResearchPriorState, options?: unknown): Promise<ResearchIterationAssessment>;
  CompileDeepResearchReport(prompt: string, finalState: DeepResearchPriorState, options?: unknown): Promise<DeepResearchCompiledReport>;
};

export type GeneratedDeepResearchBamlAdapterOptions = {
  client?: DeepResearchBamlClient;
  usageCollector?: WorkflowUsageCollector;
};

export class GeneratedDeepResearchBamlAdapter implements DeepResearchBamlClient {
  private readonly client: DeepResearchBamlClient;
  private readonly usageCollector?: WorkflowUsageCollector;

  constructor(options: GeneratedDeepResearchBamlAdapterOptions = {}) {
    this.client = options.client ?? (b as unknown as DeepResearchBamlClient);
    this.usageCollector = options.usageCollector;
  }

  async GenerateResearchQuestions(
    prompt: string,
    priorState: DeepResearchPriorState,
    config: DeepResearchConfig,
  ): Promise<ResearchQuestionSet> {
    return this.invoke(
      "GenerateResearchQuestions",
      GENERATE_RESEARCH_QUESTIONS_OPTIONS,
      (options) => this.client.GenerateResearchQuestions(prompt, priorState, config, options),
    );
  }

  async AssessResearchIteration(
    questionSet: ResearchQuestionSet,
    evidence: DeepResearchEvidence[],
    priorState: DeepResearchPriorState,
  ): Promise<ResearchIterationAssessment> {
    return this.invoke(
      "AssessResearchIteration",
      ASSESS_RESEARCH_ITERATION_OPTIONS,
      (options) => this.client.AssessResearchIteration(questionSet, evidence, priorState, options),
    );
  }

  async CompileDeepResearchReport(
    prompt: string,
    finalState: DeepResearchPriorState,
  ): Promise<DeepResearchCompiledReport> {
    return this.invoke(
      "CompileDeepResearchReport",
      COMPILE_DEEP_RESEARCH_REPORT_OPTIONS,
      (options) => this.client.CompileDeepResearchReport(prompt, finalState, options),
    );
  }

  private async invoke<T>(
    method: keyof typeof DEEP_RESEARCH_METHOD_MODELS,
    options: BamlClientOverride,
    call: (options: BamlClientOverride & { collector?: unknown }) => Promise<T>,
  ): Promise<T> {
    const collector = this.usageCollector?.createBamlCollector(`deep-research.${method}`);
    const callOptions = {
      ...options,
      ...(collector ? { collector } : {}),
    };
    try {
      return await call(callOptions);
    } finally {
      if (collector) {
        this.usageCollector?.recordBamlCollector({
          operation: method,
          model: DEEP_RESEARCH_METHOD_MODELS[method],
          collector,
        });
      }
    }
  }
}

export function createLiveDeepResearchBamlClient(options: {
  usageCollector?: WorkflowUsageCollector;
} = {}): DeepResearchBamlClient {
  return new GeneratedDeepResearchBamlAdapter(options);
}
