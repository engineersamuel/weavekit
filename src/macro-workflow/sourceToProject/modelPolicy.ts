export const SourceToProjectModelOperation = {
  SOURCE_READING: "source-reading",
  SOURCE_CORROBORATION: "source-corroboration",
  PROJECT_RESEARCH: "project-research",
  OPPORTUNITY_MAPPING: "opportunity-mapping",
  PLAN_GENERATION: "plan-generation",
  VISUAL_DESIGN: "visual-design",
  PLAN_DISTILLATION: "plan-distillation",
  FINAL_RECOMMENDATION_REVIEW: "final-recommendation-review",
  IMPLEMENTATION: "implementation",
  IMPLEMENTATION_FIX: "implementation-fix",
  IMPLEMENTATION_REVIEW: "implementation-review",
  WORKFLOW_PLANNING: "workflow-planning",
  DETERMINISTIC: "deterministic",
} as const;
export type SourceToProjectModelOperation =
  (typeof SourceToProjectModelOperation)[keyof typeof SourceToProjectModelOperation];

export type SourceToProjectModelDecision = {
  model: string;
  modelRationale: string;
};

export type SourceToProjectBamlRoute = SourceToProjectModelDecision & {
  client?: string;
};

export type SourceToProjectModelPolicyOptions = {
  copilotModel?: string;
  env?: NodeJS.ProcessEnv;
};

export const SOURCE_TO_PROJECT_BAML_FUNCTION_OPERATIONS = {
  DistillSourceAnalysis: SourceToProjectModelOperation.SOURCE_READING,
  DistillCorroboration: SourceToProjectModelOperation.SOURCE_CORROBORATION,
  DistillProjectBrief: SourceToProjectModelOperation.PROJECT_RESEARCH,
  MapSourceToProject: SourceToProjectModelOperation.OPPORTUNITY_MAPPING,
  DistillPlanArtifact: SourceToProjectModelOperation.PLAN_DISTILLATION,
  ReviewFinalRecommendation: SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW,
} as const;
export type SourceToProjectBamlFunctionName = keyof typeof SOURCE_TO_PROJECT_BAML_FUNCTION_OPERATIONS;

const PRIMARY_MODEL = "gpt-5.5";
const PROJECT_RESEARCH_COPILOT_MODEL = "claude-sonnet-5";
const PLANNING_MODEL = "claude-opus-4.8";
const WORKFLOW_PLANNING_MODEL = PLANNING_MODEL;
const ADVANCED_PLANNING_MODEL = "gpt-5.5";
const VISUAL_DESIGN_MODEL = "claude-opus-4.8";
const MINI_MODEL = "gpt-5-mini";
const CODEX_MODEL = "gpt-5.3-codex";
const DETERMINISTIC_MODEL = "deterministic";

const BAML_CLIENT_BY_MODEL: Record<string, string> = {
  "claude-opus-4.8": "CopilotProxyClaudeOpus48",
  "gpt-5": "CopilotProxyGpt5",
  "gpt-5-codex": "CopilotProxyGpt5Codex",
  "gpt-5-mini": "CopilotProxyGpt5Mini",
  "gpt-5.1": "CopilotProxyGpt51",
  "gpt-5.1-codex": "CopilotProxyGpt51Codex",
  "gpt-5.1-codex-max": "CopilotProxyGpt51CodexMax",
  "gpt-5.1-codex-mini": "CopilotProxyGpt51CodexMini",
  "gpt-5.2": "CopilotProxyGpt52",
  "gpt-5.2-codex": "CopilotProxyGpt52Codex",
  "gpt-5.3-codex": "CopilotProxyGpt53Codex",
  "gpt-5.4": "CopilotProxyGpt54",
  "gpt-5.5": "CopilotProxyGpt55",
};

const OPERATION_POLICY: Record<SourceToProjectModelOperation, SourceToProjectModelDecision> = {
  [SourceToProjectModelOperation.SOURCE_READING]: {
    model: PRIMARY_MODEL,
    modelRationale: "Primary source-reading and evidence extraction require the source-to-project reasoning tier.",
  },
  [SourceToProjectModelOperation.SOURCE_CORROBORATION]: {
    model: PRIMARY_MODEL,
    modelRationale: "Corroborating source claims needs the primary research model.",
  },
  [SourceToProjectModelOperation.PROJECT_RESEARCH]: {
    model: PRIMARY_MODEL,
    modelRationale: "Project research is source-conditioned and uses the primary reasoning model.",
  },
  [SourceToProjectModelOperation.OPPORTUNITY_MAPPING]: {
    model: PLANNING_MODEL,
    modelRationale: "Mapping source lessons to project opportunities needs the strongest available planning synthesis model.",
  },
  [SourceToProjectModelOperation.PLAN_GENERATION]: {
    model: PLANNING_MODEL,
    modelRationale: "Source-to-project plan generation uses the strongest available planning synthesis model.",
  },
  [SourceToProjectModelOperation.VISUAL_DESIGN]: {
    model: VISUAL_DESIGN_MODEL,
    modelRationale: "Visual design planning uses the strongest available Claude synthesis model.",
  },
  [SourceToProjectModelOperation.PLAN_DISTILLATION]: {
    model: MINI_MODEL,
    modelRationale: "Plan distillation is structured extraction from an existing plan transcript.",
  },
  [SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW]: {
    model: PRIMARY_MODEL,
    modelRationale: "Final recommendation review is the actionability and complexity gate.",
  },
  [SourceToProjectModelOperation.IMPLEMENTATION]: {
    model: CODEX_MODEL,
    modelRationale: "Autonomous implementation should use the Codex implementation tier.",
  },
  [SourceToProjectModelOperation.IMPLEMENTATION_FIX]: {
    model: ADVANCED_PLANNING_MODEL,
    modelRationale: "Review-findings fixes use the strongest available GPT model for targeted repair.",
  },
  [SourceToProjectModelOperation.IMPLEMENTATION_REVIEW]: {
    model: ADVANCED_PLANNING_MODEL,
    modelRationale: "Implementation review uses the strongest available GPT model for non-mutating review.",
  },
  [SourceToProjectModelOperation.WORKFLOW_PLANNING]: {
    model: WORKFLOW_PLANNING_MODEL,
    modelRationale: "Workflow DAG planning uses the strongest available planning synthesis model.",
  },
  [SourceToProjectModelOperation.DETERMINISTIC]: {
    model: DETERMINISTIC_MODEL,
    modelRationale: "This node is deterministic and does not invoke an LLM.",
  },
};

const BAML_OPERATION_MODEL_OVERRIDES: Partial<Record<SourceToProjectModelOperation, SourceToProjectModelDecision>> = {
  [SourceToProjectModelOperation.SOURCE_READING]: {
    model: MINI_MODEL,
    modelRationale: "Source analysis distillation is structured extraction from an existing Copilot transcript.",
  },
  [SourceToProjectModelOperation.SOURCE_CORROBORATION]: {
    model: MINI_MODEL,
    modelRationale: "Corroboration distillation is structured extraction from an existing Copilot transcript.",
  },
  [SourceToProjectModelOperation.PROJECT_RESEARCH]: {
    model: MINI_MODEL,
    modelRationale: "Project brief distillation is structured extraction from an existing Copilot transcript.",
  },
};

export function sourceToProjectModelDecision(
  operation: SourceToProjectModelOperation,
): SourceToProjectModelDecision {
  return OPERATION_POLICY[operation];
}

export function sourceToProjectCopilotModelDecision(
  operation: SourceToProjectModelOperation,
  options: Pick<SourceToProjectModelPolicyOptions, "copilotModel"> = {},
): SourceToProjectModelDecision {
  const decision = sourceToProjectModelDecision(operation);
  const override = options.copilotModel?.trim();
  if (!override) {
    if (operation === SourceToProjectModelOperation.PROJECT_RESEARCH) {
      return {
        model: PROJECT_RESEARCH_COPILOT_MODEL,
        modelRationale: "Target project repo research uses the faster Sonnet tier for bounded codebase inspection.",
      };
    }
    return decision;
  }
  return {
    model: override,
    modelRationale: `source_to_project.copilot_model overrides ${decision.model} for Copilot SDK calls.`,
  };
}

export function sourceToProjectBamlRoute(
  operation: SourceToProjectModelOperation,
  env: NodeJS.ProcessEnv = process.env,
): SourceToProjectBamlRoute {
  const override = env.BAML_MODEL?.trim();
  if (override) {
    return {
      model: override,
      client: BAML_CLIENT_BY_MODEL[override],
      modelRationale: BAML_CLIENT_BY_MODEL[override]
        ? `BAML_MODEL selects generated client ${BAML_CLIENT_BY_MODEL[override]}.`
        : "BAML_MODEL requires a runtime BAML client registry because no generated client mapping exists.",
    };
  }

  const decision = BAML_OPERATION_MODEL_OVERRIDES[operation] ?? sourceToProjectModelDecision(operation);
  return {
    ...decision,
    client: BAML_CLIENT_BY_MODEL[decision.model],
  };
}

export function sourceToProjectBamlFunctionRoute(
  functionName: SourceToProjectBamlFunctionName,
  env: NodeJS.ProcessEnv = process.env,
): SourceToProjectBamlRoute {
  return sourceToProjectBamlRoute(SOURCE_TO_PROJECT_BAML_FUNCTION_OPERATIONS[functionName], env);
}

export function sourceToProjectNodeModelMetadata(
  operation: SourceToProjectModelOperation,
  options: SourceToProjectModelPolicyOptions = {},
): SourceToProjectModelDecision {
  if (
    operation === SourceToProjectModelOperation.SOURCE_READING ||
    operation === SourceToProjectModelOperation.SOURCE_CORROBORATION ||
    operation === SourceToProjectModelOperation.PROJECT_RESEARCH ||
    operation === SourceToProjectModelOperation.PLAN_GENERATION ||
    operation === SourceToProjectModelOperation.VISUAL_DESIGN ||
    operation === SourceToProjectModelOperation.IMPLEMENTATION ||
    operation === SourceToProjectModelOperation.IMPLEMENTATION_FIX ||
    operation === SourceToProjectModelOperation.IMPLEMENTATION_REVIEW
  ) {
    return sourceToProjectCopilotModelDecision(operation, { copilotModel: options.copilotModel });
  }
  if (
    operation === SourceToProjectModelOperation.OPPORTUNITY_MAPPING ||
    operation === SourceToProjectModelOperation.PLAN_DISTILLATION ||
    operation === SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW
  ) {
    return sourceToProjectBamlRoute(operation, options.env);
  }
  return sourceToProjectModelDecision(operation);
}
