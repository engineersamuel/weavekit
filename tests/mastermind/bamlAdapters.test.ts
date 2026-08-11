import { afterEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => {
  const spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    status: unknown[];
    exceptions: unknown[];
    ended: boolean;
  }> = [];

  return {
    spans,
    startActiveSpan: vi.fn(async (name, options, fn) => {
      const span = {
        name,
        attributes: {
          ...(options as { attributes?: Record<string, unknown> } | undefined)?.attributes,
        } as Record<string, unknown>,
        status: [] as unknown[],
        exceptions: [] as unknown[],
        ended: false,
      };
      spans.push(span);
      return fn({
        setAttribute(key: string, value: unknown) {
          span.attributes[key] = value;
        },
        setStatus(value: unknown) {
          span.status.push(value);
        },
        recordException(value: unknown) {
          span.exceptions.push(value);
        },
        spanContext() {
          return { traceId: `trace-${spans.length}` };
        },
        end() {
          span.ended = true;
        },
      });
    }),
  };
});

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
  trace: {
    getTracer: vi.fn(() => ({
      startActiveSpan: telemetry.startActiveSpan,
    })),
  },
}));

import {
  MastermindAction,
  ProjectRepositoryMode,
  ReviewReadiness,
  TicketKind,
  type LinearTicketInput,
  type MastermindProjectPolicyInput,
  type MastermindReviewDecisionContext,
  type ProposedLinearTicketPatch,
  type TicketReviewDossier,
} from "../../src/generated/baml_client/index.js";
import { GeneratedMastermindDecisionProvider } from "../../src/mastermind/decision/bamlAdapters.js";

afterEach(() => {
  telemetry.spans.length = 0;
  telemetry.startActiveSpan.mockClear();
});

function createTicket(): LinearTicketInput {
  return {
    id: "issue-one",
    identifier: "WK-1",
    title: "Review-aware next action",
    description: "Plan the next action from the stored review.",
    labels: [],
    status: "Todo",
    projectId: "project-one",
    teamId: "team-one",
  };
}

function createProject(): MastermindProjectPolicyInput {
  return {
    id: "weavekit",
    displayName: "Weavekit",
    repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
    repositoryPath: process.cwd(),
    allowedActions: [
      MastermindAction.REVIEW_TICKET,
      MastermindAction.DELEGATE_SUBMIND,
      MastermindAction.NEEDS_HUMAN,
    ],
  };
}

function createDossier(): TicketReviewDossier {
  return {
    ticketKind: TicketKind.TECHNICAL_TASK,
    preservedIntent: "Plan the next action from the stored review.",
    summary: "The repository already contains the durable Mastermind control plane.",
    repositoryEvidence: [],
    linearEvidence: [],
    externalEvidence: [],
    assumptions: [],
    ambiguities: [],
    unansweredQuestions: [],
    risks: [],
    dependencies: [],
    suggestedAcceptanceCriteria: ["Mastermind preserves review ownership before planning work."],
    automatedVerification: ["nub run test -- tests/mastermind/bamlAdapters.test.ts"],
    manualVerification: [],
    validationSteps: ["Confirm the synthesis call uses the configured model override."],
    observability: [],
    rolloutPlan: [],
    rollbackPlan: [],
    outOfScope: [],
    materialScopeChange: false,
    confidence: 0.9,
  };
}

function createPatch(): ProposedLinearTicketPatch {
  return {
    proposedTitle: "Make next-action selection review-aware",
    proposedDescriptionMarkdown: "Goal\n\nUse the stored review before action planning.",
    ticketKind: TicketKind.TECHNICAL_TASK,
    preservedIntent: "Plan the next action from the stored review.",
    acceptanceCriteria: ["Mastermind preserves review ownership before planning work."],
    assumptions: [],
    ambiguities: [],
    unansweredQuestions: [],
    openItemDispositions: [],
    dependencies: [],
    risks: [],
    automatedVerification: ["nub run test -- tests/mastermind/bamlAdapters.test.ts"],
    manualVerification: [],
    validationSteps: ["Confirm the synthesis call uses the configured model override."],
    observability: [],
    rolloutPlan: [],
    rollbackPlan: [],
    outOfScope: [],
    evidence: [],
    readiness: ReviewReadiness.READY,
    blockingReasons: [],
    warnings: [],
    materialScopeChange: false,
    requiresHumanApproval: false,
    confidence: 0.92,
  };
}

describe("GeneratedMastermindDecisionProvider", () => {
  it("keeps the synthesis override independent from DecideNextAction BAML_MODEL behavior", async () => {
    const originalModel = process.env.BAML_MODEL;
    process.env.BAML_MODEL = "claude-sonnet-5";
    try {
      const synthOptions: Array<Record<string, unknown> | undefined> = [];
      const decideOptions: Array<Record<string, unknown> | undefined> = [];
      const provider = new GeneratedMastermindDecisionProvider(
        {
          async SynthesizeLinearTicketPatch() {
            const options = arguments[3] as Record<string, unknown> | undefined;
            synthOptions.push(options);
            return createPatch();
          },
          async DecideNextAction() {
            const options = arguments[3] as Record<string, unknown> | undefined;
            decideOptions.push(options);
            return {
              action: MastermindAction.DELEGATE_SUBMIND,
              rationale: "The current review is ready for bounded implementation.",
              prerequisites: [],
              policyEvidence: ["Project mapping permits this action."],
              suggestedExecutorShape: "bounded submind",
              confidence: 0.95,
            };
          },
        },
        {
          synthesisModel: "gemini-3.6-flash",
          synthesisClientEnv: {
            baseUrl: "http://proxy.test/v1",
            apiKey: "test-key",
          },
        },
      );

      const ticket = createTicket();
      const project = createProject();
      const review: MastermindReviewDecisionContext = {
        hasCurrentReview: true,
        readiness: ReviewReadiness.READY,
        requiresHumanApproval: false,
        blockingReasons: [],
        warnings: [],
        unansweredQuestions: [],
        openItemDispositions: [],
        reviewConfidence: 0.92,
      };

      await provider.synthesizeTicketPatch(ticket, project, createDossier());
      await provider.decideNextAction(ticket, project, review);

      expect(synthOptions).toHaveLength(1);
      expect(synthOptions[0]).toMatchObject({
        collector: expect.anything(),
        clientRegistry: expect.anything(),
      });
      expect(decideOptions).toHaveLength(1);
      expect(decideOptions[0]).toMatchObject({
        collector: expect.anything(),
      });
      expect(decideOptions[0]).not.toHaveProperty("clientRegistry");

      const synthesisSpan = telemetry.spans.find(
        (span) => span.name === "mastermind.baml.synthesize_ticket_patch",
      );
      const decideSpan = telemetry.spans.find(
        (span) => span.name === "mastermind.baml.decide_next_action",
      );
      expect(synthesisSpan?.attributes["gen_ai.request.model"]).toBe("gemini-3.6-flash");
      expect(decideSpan?.attributes["gen_ai.request.model"]).toBeUndefined();
    } finally {
      if (originalModel === undefined) {
        delete process.env.BAML_MODEL;
      } else {
        process.env.BAML_MODEL = originalModel;
      }
    }
  });

  it("records the configured synthesis model on the synthesis span", async () => {
    const provider = new GeneratedMastermindDecisionProvider(
      {
        async SynthesizeLinearTicketPatch() {
          return createPatch();
        },
        async DecideNextAction() {
          return {
            action: MastermindAction.REVIEW_TICKET,
            rationale: "A current review does not exist yet.",
            prerequisites: [],
            policyEvidence: ["Review is required before implementation."],
            suggestedExecutorShape: null,
            confidence: 1,
          };
        },
      },
      {
        synthesisModel: "gemini-3.6-flash",
        synthesisClientEnv: {
          baseUrl: "http://proxy.test/v1",
          apiKey: "test-key",
        },
      },
    );

    await provider.synthesizeTicketPatch(createTicket(), createProject(), createDossier());

    expect(telemetry.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "mastermind.baml.synthesize_ticket_patch",
          attributes: expect.objectContaining({
            "gen_ai.request.model": "gemini-3.6-flash",
            "weavekit.mastermind.baml.operation": "synthesis",
          }),
        }),
      ]),
    );
  });

  it("defaults the synthesis model from BAML_MODEL before falling back to gpt-5.5", async () => {
    const originalModel = process.env.BAML_MODEL;
    process.env.BAML_MODEL = "claude-sonnet-5";
    try {
      const provider = new GeneratedMastermindDecisionProvider(
        {
          async SynthesizeLinearTicketPatch() {
            return createPatch();
          },
          async DecideNextAction() {
            return {
              action: MastermindAction.REVIEW_TICKET,
              rationale: "A current review does not exist yet.",
              prerequisites: [],
              policyEvidence: ["Review is required before implementation."],
              suggestedExecutorShape: null,
              confidence: 1,
            };
          },
        },
        {
          synthesisClientEnv: {
            baseUrl: "http://proxy.test/v1",
            apiKey: "test-key",
          },
        },
      );

      await provider.synthesizeTicketPatch(createTicket(), createProject(), createDossier());

      expect(telemetry.spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "mastermind.baml.synthesize_ticket_patch",
            attributes: expect.objectContaining({
              "gen_ai.request.model": "claude-sonnet-5",
            }),
          }),
        ]),
      );
    } finally {
      if (originalModel === undefined) {
        delete process.env.BAML_MODEL;
      } else {
        process.env.BAML_MODEL = originalModel;
      }
    }
  });
});
