import { ClientRegistry } from "@boundaryml/baml";
import { b } from "../../generated/baml_client/index.js";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../generated/baml_client/types.js";
import {
  summarizeAbsoluteEvidenceIssues,
  validateAbsoluteJudgeEvidence,
} from "./evidenceValidation.js";
import type {
  AbsoluteJudgeRepairMetadata,
  RecordedAbsoluteJudgeOutcome,
  SourceToProjectPlanJudge,
} from "./judge.js";
import { noAbsoluteJudgeRepairMetadata } from "./judge.js";

export type BamlJudgeFunctions = {
  JudgeSourceToProjectPlan(
    caseJson: string,
    planMarkdown: string,
    validationFeedback: string,
    options: BamlJudgeCallOptions,
  ): Promise<SourceToProjectPlanJudgment>;
  CompareSourceToProjectPlans(
    caseJson: string,
    planA: string,
    planB: string,
    options: BamlJudgeCallOptions,
  ): Promise<SourceToProjectPairwiseJudgment>;
};

export type BamlJudgeCallOptions = {
  client?: string;
  clientRegistry?: ClientRegistry;
};

export function createBamlSourceToProjectPlanJudge(args: {
  id: string;
  client: string;
  bamlClientName?: string;
  callOptions?: BamlJudgeCallOptions;
  baml?: BamlJudgeFunctions;
}): SourceToProjectPlanJudge {
  const client = args.baml ?? (b as BamlJudgeFunctions);
  const callOptions = args.callOptions ?? { client: args.client };
  const judgePlanWithMetadata = async (input: {
    caseJson: string;
    planMarkdown: string;
  }): Promise<RecordedAbsoluteJudgeOutcome> => {
    let first: SourceToProjectPlanJudgment;
    try {
      first = await client.JudgeSourceToProjectPlan(
        input.caseJson,
        input.planMarkdown,
        "",
        callOptions,
      );
    } catch (error) {
      return { ok: false, error, repairMetadata: noAbsoluteJudgeRepairMetadata() };
    }
    const issues = validateAbsoluteJudgeEvidence({
      judgeId: args.id,
      planMarkdown: input.planMarkdown,
      result: first,
    });
    if (issues.length === 0) {
      return { ok: true, result: first, repairMetadata: noAbsoluteJudgeRepairMetadata() };
    }
    const summary = summarizeAbsoluteEvidenceIssues(issues);
    const repairMetadata: AbsoluteJudgeRepairMetadata = {
      repairAttempted: true,
      retryCount: 1,
      evidenceDefectCount: summary.evidenceDefectCount,
      evidenceDefectCodes: summary.evidenceDefectCodes,
      evidenceDefectOmittedCount: summary.evidenceDefectOmittedCount,
    };
    try {
      const result = await client.JudgeSourceToProjectPlan(
        input.caseJson,
        input.planMarkdown,
        summary.validationFeedback,
        callOptions,
      );
      return {
        ok: true,
        result: pruneInvalidEvidenceQuotes(result, input.planMarkdown),
        repairMetadata,
      };
    } catch (error) {
      return { ok: false, error, repairMetadata };
    }
  };
  return {
    id: args.id,
    bamlClientName: args.bamlClientName ?? args.client,
    judgePlan: async ({ caseJson, planMarkdown }) => {
      const outcome = await judgePlanWithMetadata({ caseJson, planMarkdown });
      if (!outcome.ok) throw outcome.error;
      return outcome.result;
    },
    judgePlanWithMetadata,
    comparePlans: ({ caseJson, planA, planB }) =>
      client.CompareSourceToProjectPlans(caseJson, planA, planB, callOptions),
  };
}

function pruneInvalidEvidenceQuotes(
  result: SourceToProjectPlanJudgment,
  planMarkdown: string,
): SourceToProjectPlanJudgment {
  const literalQuotes = (quotes: string[]) =>
    quotes.filter((quote) => quote.trim().length > 0 && planMarkdown.includes(quote));
  return {
    ...result,
    requirementAssessments: result.requirementAssessments.map((assessment) => ({
      ...assessment,
      evidenceQuotes: literalQuotes(assessment.evidenceQuotes),
    })),
    criterionAssessments: result.criterionAssessments.map((assessment) => ({
      ...assessment,
      evidenceQuotes: literalQuotes(assessment.evidenceQuotes),
    })),
  };
}

export function createDefaultSourceToProjectJudgePanel(): SourceToProjectPlanJudge[] {
  return [
    createBamlSourceToProjectPlanJudge({
      id: "gpt-5.5",
      client: "CopilotProxyGpt55",
      bamlClientName: "SourceToProjectJudge",
      callOptions: { clientRegistry: createJudgeRegistry("gpt-5.5", "openai-responses") },
    }),
    createBamlSourceToProjectPlanJudge({
      id: "claude-opus-4.8",
      client: "CopilotProxyClaudeOpus48",
      bamlClientName: "SourceToProjectJudge",
      callOptions: { clientRegistry: createJudgeRegistry("claude-opus-4.8", "openai-generic") },
    }),
  ];
}

function createJudgeRegistry(
  model: string,
  provider: "openai-generic" | "openai-responses",
): ClientRegistry {
  const registry = new ClientRegistry();
  registry.addLlmClient("SourceToProjectJudge", provider, {
    base_url:
      process.env.PROJECT_VERIFICATION_JUDGE_BASE_URL ??
      process.env.COPILOT_PROXY_BASE_URL ??
      "http://127.0.0.1:8080/v1",
    api_key:
      process.env.PROJECT_VERIFICATION_JUDGE_API_KEY ??
      process.env.COPILOT_PROXY_API_KEY ??
      "sk-local",
    model,
    http: { request_timeout_ms: judgeRequestTimeoutMs() },
  });
  registry.setPrimary("SourceToProjectJudge");
  return registry;
}

function judgeRequestTimeoutMs(): number {
  const configured = process.env.PROJECT_VERIFICATION_JUDGE_TIMEOUT_MS;
  if (configured === undefined) return 300_000;
  const timeoutMs = Number(configured);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("PROJECT_VERIFICATION_JUDGE_TIMEOUT_MS must be a positive integer.");
  }
  return timeoutMs;
}
