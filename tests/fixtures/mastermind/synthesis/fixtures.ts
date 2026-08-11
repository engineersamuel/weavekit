import {
  MastermindAction,
  ProjectRepositoryMode,
  RepositoryEvidenceType,
  ReviewEvidenceKind,
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  TicketKind,
  type LinearTicketInput,
  type MastermindProjectPolicyInput,
  type TicketReviewDossier,
} from "../../../../src/generated/baml_client/index.js";

export type MastermindSynthesisBenchmarkOpenItem = {
  kind: ReviewOpenItemKind;
  owner: ReviewOpenItemOwner;
  text: string;
};

export type MastermindSynthesisBenchmarkFixture = {
  id: string;
  label: string;
  ticket: LinearTicketInput;
  project: MastermindProjectPolicyInput;
  dossier: TicketReviewDossier;
  requiredFacts: string[];
  expected: {
    readiness: ReviewReadiness;
    requiresHumanApproval: boolean;
    openItems?: MastermindSynthesisBenchmarkOpenItem[];
    materialScopeChange?: boolean;
  };
};

function existingRepositoryProject(): MastermindProjectPolicyInput {
  return {
    id: "weavekit",
    displayName: "Weavekit",
    repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
    repositoryPath: process.cwd(),
    allowedActions: [
      MastermindAction.REVIEW_TICKET,
      MastermindAction.IMPLEMENT_DIRECTLY,
      MastermindAction.DELEGATE_SUBMIND,
      MastermindAction.WAIT,
      MastermindAction.NEEDS_HUMAN,
    ],
  };
}

function greenfieldProject(): MastermindProjectPolicyInput {
  return {
    id: "prototypes",
    displayName: "Prototypes",
    repositoryMode: ProjectRepositoryMode.GREENFIELD,
    provisioningRoot: "/workspace/prototypes",
    allowedActions: [
      MastermindAction.REVIEW_TICKET,
      MastermindAction.IMPLEMENT_DIRECTLY,
      MastermindAction.DELEGATE_SUBMIND,
      MastermindAction.WAIT,
      MastermindAction.NEEDS_HUMAN,
    ],
  };
}

export const MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES: MastermindSynthesisBenchmarkFixture[] = [
  {
    id: "ready-existing-repository",
    label: "Ready existing-repository technical task",
    ticket: {
      id: "fixture-1",
      identifier: "WK-BENCH-1",
      title: "Thread review-aware routing through the durable control plane",
      description:
        "Use the stored review dossier before planning bounded implementation for an existing repository task.",
      labels: [],
      status: "Todo",
      projectId: "project-weavekit",
      teamId: "team-weavekit",
    },
    project: existingRepositoryProject(),
    dossier: {
      ticketKind: TicketKind.TECHNICAL_TASK,
      preservedIntent: "Plan the next action from the stored review without changing scope.",
      summary: "The durable Mastermind control plane already exists in the repository.",
      repositoryEvidence: [
        {
          id: "repo-mastermind-loop",
          kind: ReviewEvidenceKind.REPOSITORY,
          repositoryEvidenceType: RepositoryEvidenceType.FILE,
          repositoryPath: "src/mastermind/decision/loop.ts",
          claim: "The decision loop already drives review, policy validation, and action planning.",
          confidence: 1,
        },
      ],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: [],
      risks: ["Routing must stay deterministic when the stored review is stale."],
      dependencies: [],
      suggestedAcceptanceCriteria: [
        "Mastermind plans the next action only after an accepted stored review exists.",
      ],
      automatedVerification: ["nub run test -- tests/mastermind/controlPlane.test.ts"],
      manualVerification: [],
      validationSteps: ["Confirm the planned action matches the stored review context."],
      observability: ["Record the chosen next action on the work trace."],
      rolloutPlan: [
        "Ship the deterministic routing change behind the existing Mastermind service.",
      ],
      rollbackPlan: ["Revert the routing change and keep the prior review gate."],
      outOfScope: [],
      materialScopeChange: false,
      confidence: 0.94,
    },
    requiredFacts: [
      "Plan the next action from the stored review without changing scope.",
      "Mastermind plans the next action only after an accepted stored review exists.",
    ],
    expected: {
      readiness: ReviewReadiness.READY,
      requiresHumanApproval: false,
    },
  },
  {
    id: "greenfield-prototype",
    label: "Greenfield prototype with no repository evidence",
    ticket: {
      id: "fixture-2",
      identifier: "WK-BENCH-2",
      title: "Draft the first prototype ticket for a greenfield project",
      description:
        "Clarify the prototype scope without inventing a repository that does not exist yet.",
      labels: [],
      status: "Todo",
      projectId: "project-prototypes",
      teamId: "team-weavekit",
    },
    project: greenfieldProject(),
    dossier: {
      ticketKind: TicketKind.SPIKE,
      preservedIntent: "Clarify the greenfield prototype scope before implementation starts.",
      summary: "No repository exists yet for the prototype; planning must stay greenfield-aware.",
      repositoryEvidence: [],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: ["The future prototype will be created under the provisioning root."],
      ambiguities: [],
      unansweredQuestions: [],
      risks: ["The review must not claim repository evidence for a greenfield project."],
      dependencies: [],
      suggestedAcceptanceCriteria: ["The ticket stays explicit that no repository exists yet."],
      automatedVerification: [],
      manualVerification: ["Confirm the ticket does not reference repository files or symbols."],
      validationSteps: ["Confirm the prototype scope is understandable to a future executor."],
      observability: ["Record that repository evidence is intentionally empty."],
      rolloutPlan: ["Create the first prototype directory only after a governed executor starts."],
      rollbackPlan: ["Drop the prototype ticket update if the greenfield scope changes."],
      outOfScope: ["Creating the prototype repository during review."],
      materialScopeChange: false,
      confidence: 0.88,
    },
    requiredFacts: ["no repository exists yet", "Creating the prototype repository during review."],
    expected: {
      readiness: ReviewReadiness.READY,
      requiresHumanApproval: false,
    },
  },
  {
    id: "executor-preflight-gap",
    label: "Nonblocking executor-preflight gap",
    ticket: {
      id: "fixture-3",
      identifier: "WK-BENCH-3",
      title: "Benchmark the synthesis model override",
      description:
        "The proxy runtime must be verified immediately before implementation, but no product decision is missing.",
      labels: [],
      status: "Todo",
      projectId: "project-weavekit",
      teamId: "team-weavekit",
    },
    project: existingRepositoryProject(),
    dossier: {
      ticketKind: TicketKind.TECHNICAL_TASK,
      preservedIntent: "Compare synthesis models without changing approval semantics.",
      summary: "The proxy runtime can be verified during executor preflight.",
      repositoryEvidence: [
        {
          id: "repo-baml-adapter",
          kind: ReviewEvidenceKind.REPOSITORY,
          repositoryEvidenceType: RepositoryEvidenceType.FILE,
          repositoryPath: "src/mastermind/decision/bamlAdapters.ts",
          claim: "The synthesis adapter already owns the BAML call boundary.",
          confidence: 1,
        },
      ],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: ["Is the proxy runtime advertising gemini-3.6-flash today?"],
      risks: ["The benchmark must not switch the default model without passing quality gates."],
      dependencies: [],
      suggestedAcceptanceCriteria: [
        "The benchmark preserves current readiness and approval semantics.",
      ],
      automatedVerification: ["nub run test -- tests/mastermind/bamlAdapters.test.ts"],
      manualVerification: [],
      validationSteps: ["Confirm the candidate model is benchmarked before becoming default."],
      observability: ["Attach the selected synthesis model to the Langfuse span."],
      rolloutPlan: ["Enable the synthesis-only override after the benchmark gates pass."],
      rollbackPlan: ["Revert the synthesis_model config to the previous baseline."],
      outOfScope: [],
      materialScopeChange: false,
      confidence: 0.9,
    },
    requiredFacts: [
      "Is the proxy runtime advertising gemini-3.6-flash today?",
      "The benchmark preserves current readiness and approval semantics.",
    ],
    expected: {
      readiness: ReviewReadiness.READY_WITH_NONBLOCKING_GAPS,
      requiresHumanApproval: false,
      openItems: [
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
          text: "Is the proxy runtime advertising gemini-3.6-flash today?",
        },
      ],
    },
  },
  {
    id: "external-dependency-wait",
    label: "Blocked external dependency that should route to WAIT",
    ticket: {
      id: "fixture-4",
      identifier: "WK-BENCH-4",
      title: "Wait for upstream sandbox access",
      description:
        "A required vendor sandbox is unavailable and must become reachable before implementation can start.",
      labels: [],
      status: "Todo",
      projectId: "project-weavekit",
      teamId: "team-weavekit",
    },
    project: existingRepositoryProject(),
    dossier: {
      ticketKind: TicketKind.TECHNICAL_TASK,
      preservedIntent: "Keep the ticket blocked until the external sandbox is reachable again.",
      summary:
        "The executor can observe the vendor sandbox status but cannot unblock the external system.",
      repositoryEvidence: [
        {
          id: "repo-live-runtime",
          kind: ReviewEvidenceKind.REPOSITORY,
          repositoryEvidenceType: RepositoryEvidenceType.FILE,
          repositoryPath: "scripts/mastermind-live.ts",
          claim: "Mastermind already has a live runtime path that can wait and retry safely.",
          confidence: 1,
        },
      ],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: ["When will the vendor sandbox become reachable again?"],
      risks: ["The executor must not misclassify the external outage as executor preflight."],
      dependencies: ["Vendor sandbox availability."],
      suggestedAcceptanceCriteria: [
        "Mastermind preserves the external blocker and routes the ticket to WAIT without human approval.",
      ],
      automatedVerification: ["nub run test -- tests/mastermind/controlPlane.test.ts"],
      manualVerification: [],
      validationSteps: ["Confirm the reviewed ticket remains blocked on the external dependency."],
      observability: ["Record the external blocker on the review and action-planning trace."],
      rolloutPlan: [],
      rollbackPlan: [],
      outOfScope: ["Resolving the vendor outage from within the executor."],
      materialScopeChange: false,
      confidence: 0.89,
    },
    requiredFacts: [
      "When will the vendor sandbox become reachable again?",
      "Mastermind preserves the external blocker and routes the ticket to WAIT without human approval.",
    ],
    expected: {
      readiness: ReviewReadiness.BLOCKED,
      requiresHumanApproval: false,
      openItems: [
        {
          kind: ReviewOpenItemKind.BLOCKING_REASON,
          owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
          text: "The vendor sandbox is unavailable to the executor.",
        },
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
          text: "When will the vendor sandbox become reachable again?",
        },
      ],
    },
  },
  {
    id: "human-owned-acceptance-question",
    label: "Human-owned product or acceptance question",
    ticket: {
      id: "fixture-5",
      identifier: "WK-BENCH-5",
      title: "Clarify the compatibility promise",
      description:
        "A product owner must choose the acceptance policy before implementation can begin.",
      labels: [],
      status: "Todo",
      projectId: "project-weavekit",
      teamId: "team-weavekit",
    },
    project: existingRepositoryProject(),
    dossier: {
      ticketKind: TicketKind.USER_STORY,
      preservedIntent: "Keep the compatibility promise explicit and human-owned.",
      summary: "The stored review must not let the executor choose a product promise.",
      repositoryEvidence: [
        {
          id: "repo-adr",
          kind: ReviewEvidenceKind.REPOSITORY,
          repositoryEvidenceType: RepositoryEvidenceType.FILE,
          repositoryPath: "docs/adr/0009-mastermind-durable-control-plane.md",
          claim:
            "Mastermind keeps product intent and approval decisions deterministic and fail-closed.",
          confidence: 1,
        },
      ],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: ["Which compatibility promise is required?"],
      risks: ["The executor must not infer a product promise from repository hints."],
      dependencies: [],
      suggestedAcceptanceCriteria: [
        "The ticket asks the product owner to choose the compatibility promise explicitly.",
      ],
      automatedVerification: [],
      manualVerification: ["Confirm the review does not mark the ticket implementation-ready."],
      validationSteps: ["Confirm the ticket stays blocked until a human resolves the policy."],
      observability: ["Record the human-owned blocker on the review trace."],
      rolloutPlan: [],
      rollbackPlan: [],
      outOfScope: [],
      materialScopeChange: false,
      confidence: 0.93,
    },
    requiredFacts: [
      "Which compatibility promise is required?",
      "The ticket asks the product owner to choose the compatibility promise explicitly.",
    ],
    expected: {
      readiness: ReviewReadiness.BLOCKED,
      requiresHumanApproval: true,
      openItems: [
        {
          kind: ReviewOpenItemKind.BLOCKING_REASON,
          owner: ReviewOpenItemOwner.HUMAN,
          text: "The product owner must choose the compatibility promise explicitly.",
        },
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          owner: ReviewOpenItemOwner.HUMAN,
          text: "Which compatibility promise is required?",
        },
      ],
    },
  },
  {
    id: "blocked-scope-authorization-change",
    label: "Blocked scope or authorization change",
    ticket: {
      id: "fixture-6",
      identifier: "WK-BENCH-6",
      title: "Expand the review to a new tenant",
      description:
        "The work now touches a second tenant and needs explicit authorization before implementation.",
      labels: [],
      status: "Todo",
      projectId: "project-weavekit",
      teamId: "team-weavekit",
    },
    project: existingRepositoryProject(),
    dossier: {
      ticketKind: TicketKind.OPERATIONAL,
      preservedIntent: "Block the ticket until the tenant expansion is explicitly approved.",
      summary: "The new tenant scope changes authorization and must stay fail-closed.",
      repositoryEvidence: [
        {
          id: "repo-config",
          kind: ReviewEvidenceKind.REPOSITORY,
          repositoryEvidenceType: RepositoryEvidenceType.FILE,
          repositoryPath: "src/config.ts",
          claim:
            "Project execution policy already models explicit tenant and subscription context.",
          confidence: 1,
        },
      ],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: ["Which tenant is authorized for the rollout?"],
      risks: ["The executor must not switch tenants implicitly."],
      dependencies: [],
      suggestedAcceptanceCriteria: [
        "The ticket stays blocked until tenant authorization is explicit.",
      ],
      automatedVerification: [],
      manualVerification: ["Confirm the ticket remains blocked for authorization."],
      validationSteps: ["Confirm rollout does not start before the authorization decision exists."],
      observability: ["Record the authorization blocker on the review trace."],
      rolloutPlan: [],
      rollbackPlan: [],
      outOfScope: ["Implicit tenant switching during review or execution."],
      materialScopeChange: true,
      confidence: 0.91,
    },
    requiredFacts: [
      "Which tenant is authorized for the rollout?",
      "The ticket stays blocked until tenant authorization is explicit.",
    ],
    expected: {
      readiness: ReviewReadiness.BLOCKED,
      requiresHumanApproval: true,
      openItems: [
        {
          kind: ReviewOpenItemKind.BLOCKING_REASON,
          owner: ReviewOpenItemOwner.HUMAN,
          text: "The ticket stays blocked until tenant authorization is explicit.",
        },
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          owner: ReviewOpenItemOwner.HUMAN,
          text: "Which tenant is authorized for the rollout?",
        },
      ],
      materialScopeChange: true,
    },
  },
];

export const MASTERMIND_SYNTHESIS_BENCHMARK_OWNERSHIP = {
  EXECUTOR_PREFLIGHT: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
  EXTERNAL_DEPENDENCY: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
  HUMAN: ReviewOpenItemOwner.HUMAN,
} as const;
