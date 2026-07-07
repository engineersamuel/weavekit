export type VerificationOpportunityAdvancementSummary = {
  totalCount: number;
  advancedCount: number;
  notAdvancedCount: number;
  capLabel: string;
  rankingRationale?: string;
  opportunities: VerificationOpportunityAdvancementItem[];
};

export type VerificationOpportunityAdvancementItem = {
  id: string;
  title: string;
  status: "advanced" | "not-advanced";
  badgeLabel: string;
  runId?: string;
  reportNodeId?: string;
  currentVerificationGap?: string;
  targetChange?: string;
  proofCommands: string[];
  score?: {
    confidence?: number;
    impact?: number;
    risk?: number;
    implementationCost?: number;
  };
};

export type DeepResearchQuestionBatchSummary = {
  runId?: string;
  iteration: number;
  questionCount: number;
  providerCount: number;
  maxResultsPerQuestion?: number;
  providerStrategy: string[];
  questions: DeepResearchQuestionSummary[];
};

export type DeepResearchProviderFailureSummary = {
  runId?: string;
  failureCount: number;
  evidenceCount: number;
  failures: DeepResearchProviderFailureItem[];
};

export type DeepResearchProviderFailureItem = {
  provider: string;
  iteration: number;
  retryCount: number;
  message: string;
  questionCount: number;
};

export type DeepResearchQuestionSummary = {
  id: string;
  text: string;
  researchMode?: string;
  researchModeLabel?: string;
  researchModeRationale?: string;
  routedProviders: string[];
  providerHints: string[];
  queryCount: number;
};

export function buildDeepResearchProviderFailureSummary(payload: unknown): DeepResearchProviderFailureSummary | null {
  const record = asRecord(payload);
  const failures = readArray(record.deepResearchProviderFailures)
    .map(asRecord)
    .flatMap((failure) => {
      const provider = readString(failure.provider);
      const message = readString(failure.message);
      const iteration = readNumber(failure.iteration);
      const retryCount = readNumber(failure.retryCount);
      if (!provider || !message || iteration === undefined || retryCount === undefined) {
        return [];
      }
      return [{
        provider,
        iteration,
        retryCount,
        message,
        questionCount: readArray(failure.questionIds).length,
      }];
    });
  if (failures.length === 0) {
    return null;
  }

  return {
    runId: readString(record.deepResearchRunId),
    failureCount: failures.length,
    evidenceCount: readArray(record.deepResearchEvidence).length,
    failures,
  };
}

export function buildVerificationOpportunityAdvancementSummary(payload: unknown): VerificationOpportunityAdvancementSummary | null {
  const record = asRecord(payload);
  const review = asRecord(record.verificationOpportunityReview);
  const opportunities = readArray(review.opportunities).map(asRecord).filter((opportunity) => readString(opportunity.id));
  if (opportunities.length === 0) {
    return null;
  }

  const candidateByOpportunityId = new Map(
    readArray(record.verificationExternalResearchCandidates)
      .map(asRecord)
      .flatMap((candidate) => {
        const opportunityId = readString(candidate.opportunityId);
        return opportunityId ? [[opportunityId, candidate] as const] : [];
      }),
  );
  const advancedCount = [...candidateByOpportunityId.keys()].filter((id) =>
    opportunities.some((opportunity) => readString(opportunity.id) === id)
  ).length;

  return {
    totalCount: opportunities.length,
    advancedCount,
    notAdvancedCount: opportunities.length - advancedCount,
    capLabel: `${advancedCount} of ${opportunities.length} advancing to external research`,
    rankingRationale: readString(review.rankingRationale),
    opportunities: opportunities.map((opportunity, index) => {
      const id = readString(opportunity.id) ?? `opportunity-${index + 1}`;
      const candidate = candidateByOpportunityId.get(id);
      return {
        id,
        title: readString(opportunity.title) ?? `Opportunity ${index + 1}`,
        status: candidate ? "advanced" : "not-advanced",
        badgeLabel: candidate ? "Advancing to research" : "Not advanced",
        runId: readString(candidate?.runId),
        reportNodeId: readString(candidate?.reportNodeId),
        currentVerificationGap: readString(opportunity.currentVerificationGap),
        targetChange: readString(opportunity.targetChange),
        proofCommands: readArray(opportunity.proofCommands).flatMap((value) => {
          const command = readString(value);
          return command ? [command] : [];
        }),
        score: readScore(opportunity.score),
      };
    }),
  };
}

export function buildDeepResearchQuestionBatchSummary(payload: unknown): DeepResearchQuestionBatchSummary | null {
  const record = asRecord(payload);
  const questionSet = asRecord(record.deepResearchQuestionSet);
  const questions = readArray(questionSet.questions).map(asRecord).filter((question) => readString(question.id) || readString(question.text));
  if (questions.length === 0) {
    return null;
  }

  const config = asRecord(record.deepResearchConfig);
  const providers = readArray(config.providers).flatMap((value) => {
    const provider = readString(value);
    return provider ? [provider] : [];
  });

  return {
    runId: readString(record.deepResearchRunId),
    iteration: readNumber(questionSet.iteration) ?? readNumber(record.iteration) ?? 1,
    questionCount: questions.length,
    providerCount: providers.length,
    maxResultsPerQuestion: readNumber(config.maxResultsPerQuestion),
    providerStrategy: buildProviderStrategyLabels(questions, providers),
    questions: questions.map((question, index) => {
      const providerHints = readArray(question.providerHints).flatMap((value) => {
        const hint = readString(value);
        return hint ? [hint] : [];
      });
      const researchMode = readString(question.researchMode);
      return {
        id: readString(question.id) ?? `question-${index + 1}`,
        text: readString(question.text) ?? "",
        researchMode,
        researchModeLabel: researchMode ? researchModeLabel(researchMode) : undefined,
        researchModeRationale: readString(question.researchModeRationale),
        routedProviders: routedProvidersForQuestion(researchMode, providerHints, providers),
        providerHints,
        queryCount: readArray(question.searchQueries).length,
      };
    }),
  };
}

function buildProviderStrategyLabels(questions: Record<string, unknown>[], configuredProviders: string[]): string[] {
  const modes = uniqueStrings(questions.flatMap((question) => {
    const mode = readString(question.researchMode);
    return mode ? [mode] : [];
  }));
  if (modes.length > 0) {
    return modes
      .sort(compareResearchModeOrder)
      .map((mode) => `${mode} routes to ${routedProvidersForQuestion(mode, [], configuredProviders).join(" and ") || "no external providers"}.`);
  }
  return configuredProviders.slice().sort(compareProviderStrategyOrder).map(providerStrategyLabel);
}

function providerStrategyLabel(provider: string): string {
  if (provider === "exa") {
    return "Exa searches each question/query pair inside the provider node.";
  }
  if (provider === "grok") {
    return "Grok currently receives the whole question batch in one provider call.";
  }
  if (provider === "copilot-last30days") {
    return "copilot-last30days currently receives the whole question batch in one provider call.";
  }
  return `${provider} receives the question batch in one provider node.`;
}

function routedProvidersForQuestion(
  researchMode: string | undefined,
  providerHints: string[],
  configuredProviders: string[],
): string[] {
  if (researchMode) {
    return configuredProviders.filter((provider) => providersForResearchMode(researchMode).includes(provider));
  }
  const hintedProviders = providerHints.filter((provider) => configuredProviders.includes(provider));
  return hintedProviders.length > 0 ? hintedProviders : configuredProviders;
}

function providersForResearchMode(researchMode: string): string[] {
  if (researchMode === "local-only") {
    return [];
  }
  if (researchMode === "official-docs" || researchMode === "web-lookup") {
    return ["exa"];
  }
  if (researchMode === "recency-social") {
    return ["grok", "copilot-last30days"];
  }
  if (researchMode === "deep-research") {
    return ["grok", "exa", "copilot-last30days", "tavily", "perplexity"];
  }
  return [];
}

function researchModeLabel(researchMode: string): string {
  if (researchMode === "local-only") {
    return "Local only";
  }
  if (researchMode === "official-docs") {
    return "Official docs";
  }
  if (researchMode === "web-lookup") {
    return "Web lookup";
  }
  if (researchMode === "recency-social") {
    return "Recency/social";
  }
  if (researchMode === "deep-research") {
    return "Deep research";
  }
  return researchMode;
}

function compareResearchModeOrder(left: string, right: string): number {
  return researchModeOrder(left) - researchModeOrder(right);
}

function researchModeOrder(researchMode: string): number {
  if (researchMode === "local-only") {
    return 0;
  }
  if (researchMode === "official-docs") {
    return 1;
  }
  if (researchMode === "web-lookup") {
    return 2;
  }
  if (researchMode === "recency-social") {
    return 3;
  }
  if (researchMode === "deep-research") {
    return 4;
  }
  return 5;
}

function compareProviderStrategyOrder(left: string, right: string): number {
  return providerStrategyOrder(left) - providerStrategyOrder(right);
}

function providerStrategyOrder(provider: string): number {
  if (provider === "exa") {
    return 0;
  }
  if (provider === "grok") {
    return 1;
  }
  if (provider === "copilot-last30days") {
    return 2;
  }
  return 3;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readScore(value: unknown): VerificationOpportunityAdvancementItem["score"] | undefined {
  const score = asRecord(value);
  const parsed = {
    confidence: readNumber(score.confidence),
    impact: readNumber(score.impact),
    risk: readNumber(score.risk),
    implementationCost: readNumber(score.implementationCost),
  };
  return Object.values(parsed).some((item) => item !== undefined) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
