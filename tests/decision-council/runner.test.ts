import { trace } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDecisionCouncil, type RunDecisionCouncilOptions } from "../../src/decision-council/runner.js";
import { runDecisionCouncilLoop } from "../../src/decision-council/workflow.js";
import { createDecisionCouncilWorkflow } from "../../src/flue/decisionCouncilWorkflowDefinition.js";
import { defaultPersonaSet } from "../../src/decision-council/personas.js";
import type { JudgeReducer, CritiqueNormalizer } from "../../src/decision-council/bamlAdapters.js";
import { TraceBamlOperation } from "../../src/decision-council/bamlTelemetry.js";
import type { PersonaWorker } from "../../src/decision-council/personaWorker.js";
import type { ModelRouter } from "../../src/decision-council/modelRouter.js";
import { createInitialRunState } from "../../src/decision-council/types.js";
import { createStaticPersonaSelector, type PersonaSelectionInput, type PersonaSelector } from "../../src/personas/selector.js";

const telemetry = vi.hoisted(() => {
  const startActiveSpanCalls: string[] = [];
  const spans: {
    name: string;
    parentName?: string;
    attributes: Record<string, unknown>;
    status: unknown[];
    exceptions: unknown[];
    events: { name: string; attributes: Record<string, unknown> }[];
    ended: boolean;
  }[] = [];
  let activeSpan:
    | {
        name: string;
      }
    | undefined;

  return {
    startActiveSpanCalls,
    spans,
    reset() {
      startActiveSpanCalls.length = 0;
      spans.length = 0;
      activeSpan = undefined;
    },
    getActiveSpan() {
      return activeSpan;
    },
    startActiveSpan: vi.fn(async (name: string, fn: (span: {
      setAttribute: (key: string, value: unknown) => void;
      setStatus: (value: unknown) => void;
      recordException: (value: unknown) => void;
      addEvent: (eventName: string, attributes?: Record<string, unknown>) => void;
      end: () => void;
    }) => Promise<unknown>) => {
      const parent = activeSpan;
      const span = {
        name,
        parentName: parent?.name,
        attributes: {} as Record<string, unknown>,
        status: [] as unknown[],
        exceptions: [] as unknown[],
        events: [] as { name: string; attributes: Record<string, unknown> }[],
        ended: false,
      };
      startActiveSpanCalls.push(name);
      spans.push(span);
      activeSpan = span;
      try {
        return await fn({
          setAttribute(key, value) {
            span.attributes[key] = value;
          },
          setStatus(value) {
            span.status.push(value);
          },
          recordException(value) {
            span.exceptions.push(value);
          },
          addEvent(eventName, attributes = {}) {
            span.events.push({ name: eventName, attributes });
          },
          end() {
            span.ended = true;
          },
        });
      } finally {
        activeSpan = parent;
      }
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

function fakeWorker(failPersonaIds: string[] = []): PersonaWorker {
  return {
    async runPersona({ persona, brief }) {
      if (failPersonaIds.includes(persona.id)) {
        throw new Error(`${persona.id} failed`);
      }

      return {
        personaId: persona.id,
        text: `${persona.name} critique for round ${brief.roundNumber}`,
        transcript: [`assistant: ${persona.name}`],
        metadata: { model: "fake" },
      };
    },
  };
}

function recordingWorker(seen: Set<string>): PersonaWorker {
  return {
    async runPersona({ persona, brief }) {
      seen.add(persona.id);
      return {
        personaId: persona.id,
        text: `${persona.name} critique for round ${brief.roundNumber}`,
        transcript: [`assistant: ${persona.name}`],
        metadata: { model: "fake" },
      };
    },
  };
}

const staticDefaultSelector: PersonaSelector = createStaticPersonaSelector(defaultPersonaSet);

function selectFromCandidates(input: PersonaSelectionInput, personaIds: string[]) {
  const byId = new Map((input.candidatePersonas ?? []).map((persona) => [persona.id, persona]));
  return personaIds.map((id) => {
    const persona = byId.get(id);
    if (!persona) throw new Error(`Missing candidate persona "${id}" in test selector.`);
    return persona;
  });
}

function makeRoundSelector(
  rounds: { personaIds: string[]; rationale: string }[],
  onCall?: (input: PersonaSelectionInput) => void,
): PersonaSelector {
  let callCount = 0;
  return {
    async choosePersonas(input) {
      onCall?.(input);
      const current = rounds[Math.min(callCount, rounds.length - 1)]!;
      callCount++;
      return {
        personaSet: { name: "selected", personas: selectFromCandidates(input, current.personaIds) },
        rationale: current.rationale,
      };
    },
  };
}

async function runCouncilForTest(
  input: Parameters<typeof runDecisionCouncil>[0],
  options: RunDecisionCouncilOptions = {},
) {
  return runDecisionCouncil(input, {
    ...options,
    deps: {
      personaSelector: staticDefaultSelector,
      writeArtifacts: false,
      ...options.deps,
    },
  });
}

const normalizer: CritiqueNormalizer = {
  async normalizeCritique(raw) {
    return {
      personaId: raw.personaId,
      overallSummary: `${raw.personaId} recommends testing the riskiest assumption first.`,
      summary: raw.text,
      claims: [`${raw.personaId} claim`],
      risks: [`${raw.personaId} risk`],
      questions: [`${raw.personaId} question`],
      recommendations: [`${raw.personaId} recommendation`],
    };
  },
};

function judge(roundsBeforeStop: number): JudgeReducer {
  return {
    async assessRound({ roundNumber }) {
      return {
        roundNumber,
        consensus: roundNumber >= roundsBeforeStop ? "Stop" : "Continue",
        disagreements: [],
        confidence: roundNumber >= roundsBeforeStop ? 0.8 : 0.4,
        convergence: roundNumber >= roundsBeforeStop ? 0.9 : 0.3,
        shouldContinue: roundNumber < roundsBeforeStop,
        diminishingReturns: false,
        nextRoundBrief: "Focus on remaining objections.",
      };
    },
    async createFinalReport({ failures }) {
      return {
        recommendation: "Use Flue for v0.",
        rationale: ["The workflow loop completed."],
        strongestObjections: ["Framework churn."],
        unresolvedQuestions: [],
        confidence: 0.8,
        convergence: 0.9,
        nextExperiment: "Run the council on a real design.",
        finalReportMarkdown: "# Design Council Report\n\nUse Flue for v0.",
        failedPersonas: failures,
      };
    },
  };
}

describe("runDecisionCouncil", () => {
  beforeEach(() => {
    telemetry.reset();
  });

  it("emits progress events for the council run", async () => {
    const events: string[] = [];

    await runCouncilForTest(
      { prompt: "Log this run." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
        },
        logger: {
          event(event) {
            events.push(event.type);
          },
        },
      },
    );

    expect(events).toContain("council.run.started");
    expect(events).toContain("council.round.started");
    expect(events).toContain("council.personas.started");
    expect(events).toContain("council.personas.completed");
    expect(events).toContain("council.persona.started");
    expect(events).toContain("council.persona.completed");
    expect(events).toContain("council.baml.started");
    expect(events).toContain("council.baml.completed");
    expect(events).toContain("council.round.completed");
    expect(events).toContain("council.run.completed");
  });

  it("uses the selector result in default runs and fans out only selected personas", async () => {
    const seen = new Set<string>();
    const choosePersonas = vi.fn(async (input: PersonaSelectionInput) => ({
      personaSet: {
        name: "selected",
        personas: selectFromCandidates(input, ["socratic", "pragmatic"]),
      },
      rationale: "Need one critic and one delivery-focused voice.",
    }));

    await runCouncilForTest(
      { prompt: "Choose the right personas." },
      {
        deps: {
          personaSelector: { choosePersonas },
          personaWorker: recordingWorker(seen),
          normalizer,
          judge: judge(1),
        },
      },
    );

    expect(choosePersonas).toHaveBeenCalledTimes(1);
    expect([...seen].sort()).toEqual(["pragmatic", "socratic"]);
  });

  it("creates a selector observation with persona chooser input and output", async () => {
    const choosePersonas = vi.fn(async (input: PersonaSelectionInput) => ({
      personaSet: {
        name: "selected",
        personas: selectFromCandidates(input, ["socratic", "pragmatic"]),
      },
      rationale: "Need one critic and one delivery-focused voice.",
    }));

    await runCouncilForTest(
      { prompt: "Choose the right personas." },
      {
        deps: {
          personaSelector: { choosePersonas },
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
        },
      },
    );

    const selectorSpan = telemetry.spans.find((span) => span.name === "run.council.persona-selector");
    const selectorInput = JSON.parse(selectorSpan?.attributes["langfuse.observation.input"] as string);
    const selectorOutput = JSON.parse(selectorSpan?.attributes["langfuse.observation.output"] as string);

    expect(selectorSpan?.parentName).toBe("council-run");
    expect(selectorInput).toMatchObject({
      workflowName: "decision-council",
      taskPrompt: "Choose the right personas.",
      candidatePersonaIds: expect.arrayContaining(["socratic", "pragmatic"]),
      minPersonas: 2,
      maxPersonas: 6,
    });
    expect(selectorOutput).toEqual({
      personaIds: ["socratic", "pragmatic"],
      rationale: "Need one critic and one delivery-focused voice.",
    });
  });

  it("emits normalized summary and shared round source metadata", async () => {
    const events: unknown[] = [];

    await runCouncilForTest(
      { prompt: "Log summaries across rounds." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(2),
        },
        logger: {
          event(event) {
            events.push(event);
          },
        },
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.personas.completed",
        roundNumber: 1,
        personaIds: ["socratic", "deep-module-dry", "pragmatic", "skeptic"],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.round.started",
        roundNumber: 1,
        focusSource: "initial",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.round.started",
        roundNumber: 2,
        focusSource: "judge",
        previousRoundNumber: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.baml.completed",
        operation: "normalize",
        personaId: "pragmatic",
        summary: "pragmatic recommends testing the riskiest assumption first.",
      }),
    );
  });

  it("decorates persona and baml completed events with the model in use", async () => {
    const events: unknown[] = [];
    const modelReportingNormalizer: CritiqueNormalizer = {
      async normalizeCritique(raw, onModel) {
        onModel?.("claude-haiku-4-5");
        return normalizer.normalizeCritique(raw);
      },
    };

    await runCouncilForTest(
      { prompt: "Decorate completed events with the model." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer: modelReportingNormalizer,
          judge: judge(1),
        },
        logger: {
          event(event) {
            events.push(event);
          },
        },
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "council.persona.completed", model: "fake" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.baml.completed",
        operation: "normalize",
        model: "claude-haiku-4-5",
      }),
    );
  });

  it("normalizes each persona as soon as it finishes, overlapping slower personas", async () => {
    const events: string[] = [];
    const personaWorker: PersonaWorker = {
      async runPersona({ persona, brief }) {
        if (persona.id === "skeptic") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        events.push(`worker-done:${persona.id}`);
        return {
          personaId: persona.id,
          text: `${persona.name} critique for round ${brief.roundNumber}`,
          transcript: [`assistant: ${persona.name}`],
          metadata: { model: "fake" },
        };
      },
    };
    const trackingNormalizer: CritiqueNormalizer = {
      async normalizeCritique(raw, onModel) {
        events.push(`normalize:${raw.personaId}`);
        return normalizer.normalizeCritique(raw, onModel);
      },
    };

    await runCouncilForTest(
      { prompt: "Normalize without waiting for slow personas." },
      {
        deps: {
          personaWorker,
          normalizer: trackingNormalizer,
          judge: judge(1),
        },
      },
    );

    expect(events.indexOf("normalize:socratic")).toBeLessThan(events.indexOf("worker-done:skeptic"));
  });

  it("overwrites hallucinated failedPersonas from judge with authoritative run-state failures", async () => {
    // The LLM can fabricate or drop failed personas; deterministic run-state must win.
    const hallucinatingJudge: JudgeReducer = {
      assessRound: judge(1).assessRound,
      async createFinalReport() {
        return {
          recommendation: "Use Flue.",
          rationale: ["OK"],
          strongestObjections: [],
          unresolvedQuestions: [],
          confidence: 0.8,
          convergence: 0.9,
          nextExperiment: "Try it.",
          finalReportMarkdown: "# Design Council Report\n\nUse Flue.",
          failedPersonas: [{ personaId: "hallucinated", message: "invented by LLM", retryable: false }],
        };
      },
    };

    const report = await runCouncilForTest(
      { prompt: "Test hallucination." },
      {
        deps: {
          personaWorker: fakeWorker(["socratic"]),
          normalizer,
          judge: hallucinatingJudge,
        },
      },
    );

    const failedIds = report.failedPersonas.map((f) => f.personaId);
    expect(failedIds).not.toContain("hallucinated");
    expect(failedIds).toContain("socratic");
  });

  it("runs personas, normalizes critiques, and returns a final report", async () => {
    const report = await runCouncilForTest(
      { prompt: "Should Weavekit use Flue?" },
      {
        personaSet: defaultPersonaSet,
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
    expect(report.failedPersonas).toEqual([]);
  });

  it("selects strategic personas from the personaSetName option", async () => {
    const strategicSeen = new Set<string>();
    const dynamicSelector = {
      choosePersonas: vi.fn(async () => {
        throw new Error("Dynamic selector should be bypassed for explicit personaSetName.");
      }),
    };
    await runCouncilForTest(
      { prompt: "Pick a set." },
      {
        personaSetName: "strategic",
        deps: {
          personaSelector: dynamicSelector,
          personaWorker: recordingWorker(strategicSeen),
          normalizer,
          judge: judge(1),
        },
      },
    );

    const defaultSeen = new Set<string>();
    await runCouncilForTest(
      { prompt: "Pick a set." },
      {
        deps: {
          personaWorker: recordingWorker(defaultSeen),
          normalizer,
          judge: judge(1),
        },
      },
    );

    expect(dynamicSelector.choosePersonas).not.toHaveBeenCalled();
    expect(strategicSeen.has("strategic-game-theorist")).toBe(true);
    expect(defaultSeen.has("game-theorist")).toBe(false);
  });

  it("selects dialectic personas from the personaSetName option", async () => {
    const seen = new Set<string>();
    await runCouncilForTest(
      { prompt: "Pick a set." },
      {
        personaSetName: "dialectic",
        deps: {
          personaWorker: recordingWorker(seen),
          normalizer,
          judge: judge(1),
        },
      },
    );

    expect([...seen].sort()).toEqual(["dialectic-adversary", "dialectic-advocate", "hostile-auditor"]);
  });

  it("prefers options.personaSet over personaSetName values in input/options", async () => {
    const seen = new Set<string>();
    const customSet = {
      name: "custom",
      personas: [defaultPersonaSet.personas[0]!, defaultPersonaSet.personas[2]!],
    };

    await expect(
      runCouncilForTest(
        { prompt: "Use the supplied set.", personaSetName: "nonexistent" },
        {
          personaSet: customSet,
          deps: {
            personaWorker: recordingWorker(seen),
            normalizer,
            judge: judge(1),
          },
        },
      ),
    ).resolves.toBeDefined();

    expect([...seen].sort()).toEqual(customSet.personas.map((persona) => persona.id).sort());
  });

  it("stops at max three rounds even if Judge asks to continue", async () => {
    let assessmentCount = 0;
    const trackingJudge: JudgeReducer = {
      async assessRound({ roundNumber, critiques, failures }) {
        assessmentCount++;
        return judge(10).assessRound({ roundNumber, critiques, failures });
      },
      createFinalReport: judge(10).createFinalReport,
    };

    const report = await runCouncilForTest(
      { prompt: "Keep debating forever." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: trackingJudge,
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
    expect(assessmentCount).toBe(3);
  });

  it("stops after a single round when maxRounds is 1, even if Judge asks to continue", async () => {
    let assessmentCount = 0;
    const trackingJudge: JudgeReducer = {
      async assessRound({ roundNumber, critiques, failures }) {
        assessmentCount++;
        return judge(10).assessRound({ roundNumber, critiques, failures });
      },
      createFinalReport: judge(10).createFinalReport,
    };

    const report = await runDecisionCouncil(
      { prompt: "Run a fast smoke round." },
      {
        personaSetName: "smoke",
        maxRounds: 1,
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: trackingJudge,
          writeArtifacts: false,
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
    expect(assessmentCount).toBe(1);
  });

  it("calls the selector once per round when the Judge requests another round", async () => {
    const calls: PersonaSelectionInput[] = [];
    const selector = makeRoundSelector(
      [
        { personaIds: ["socratic", "pragmatic"], rationale: "Round 1 mix." },
        { personaIds: ["deep-module-dry", "skeptic"], rationale: "Round 2 follow-up mix." },
      ],
      (input) => calls.push(input),
    );

    await runCouncilForTest(
      { prompt: "Run a second round." },
      {
        deps: {
          personaSelector: selector,
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(2),
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.roundNumber)).toEqual([1, 2]);
  });

  it("records round personaSelection ids and rationale in workflow state", async () => {
    const finalState = await runDecisionCouncilLoop(
      createInitialRunState({ prompt: "Track selected personas per round." }, defaultPersonaSet),
      {
        personaSelector: makeRoundSelector([
          {
            personaIds: ["socratic", "pragmatic"],
            rationale: "Need critique and delivery viewpoints in round 1.",
          },
        ]),
        personaWorker: fakeWorker(),
        normalizer,
        judge: judge(1),
      },
    );

    expect(finalState.rounds[0]?.personaSelection).toEqual({
      personaIds: ["socratic", "pragmatic"],
      rationale: "Need critique and delivery viewpoints in round 1.",
    });
  });

  it("fails when fewer than two debating personas succeed", async () => {
    await expect(
      runCouncilForTest(
        { prompt: "Handle failures." },
        {
          deps: {
            personaWorker: fakeWorker(["socratic", "deep-module-dry", "pragmatic"]),
            normalizer,
            judge: judge(1),
          },
        },
      ),
    ).rejects.toThrow("Council requires at least two successful personas.");
  });

  it("rejects when persona selection fails and emits a personas failure event", async () => {
    const events: unknown[] = [];
    await expect(
      runCouncilForTest(
        { prompt: "Fail persona selection." },
        {
          deps: {
            personaSelector: {
              async choosePersonas() {
                throw new Error("chooser unavailable");
              },
            },
            personaWorker: fakeWorker(),
            normalizer,
            judge: judge(1),
          },
          logger: {
            event(event) {
              events.push(event);
            },
          },
        },
      ),
    ).rejects.toThrow("chooser unavailable");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.personas.failed",
        roundNumber: 1,
        error: "chooser unavailable",
      }),
    );
  });

  it("accepts a custom router without breaking the run", async () => {
    const router: ModelRouter = {
      async route() {
        return { clientName: "CopilotProxyClaudeHaiku45", model: "claude-haiku-4-5", rationale: "test" };
      },
    };

    const report = await runCouncilForTest(
      { prompt: "Route this run." },
      {
        router,
        deps: { personaWorker: fakeWorker(), normalizer, judge: judge(1) },
      },
    );

    expect(report.recommendation).toBeDefined();
  });
  it("creates a root OTEL span and nests traced BAML spans beneath it", async () => {
    class TracedNormalizer implements CritiqueNormalizer {
      @TraceBamlOperation("normalize")
      async normalizeCritique(raw: Parameters<CritiqueNormalizer["normalizeCritique"]>[0]) {
        return {
          personaId: raw.personaId,
          overallSummary: `${raw.personaId} summary`,
          summary: raw.text,
          claims: [],
          risks: [],
          questions: [],
          recommendations: [],
        };
      }
    }

    await runCouncilForTest(
      { prompt: "Trace this run." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer: new TracedNormalizer(),
          judge: judge(1),
        },
      },
    );

    const rootSpan = telemetry.spans.find((span) => span.name === "council-run");
    const normalizeSpan = telemetry.spans.find((span) => span.name === "run.council.baml.normalize");

    expect(telemetry.startActiveSpanCalls).toContain("council-run");
    expect(rootSpan?.attributes).toMatchObject({
      "weavekit.decision_council.run_id": expect.any(String),
      "weavekit.decision_council.persona_count": 10,
      "weavekit.decision_council.max_rounds": 3,
    });
    expect(rootSpan?.events).toContainEqual(
      expect.objectContaining({
        name: "council.run.started",
      }),
    );
    expect(normalizeSpan?.parentName).toBe("council-run");
    expect(rootSpan?.ended).toBe(true);
  });

  it("sets Langfuse trace and root observation input and output on the root council span", async () => {
    class TracedNormalizer implements CritiqueNormalizer {
      @TraceBamlOperation("normalize")
      async normalizeCritique(raw: Parameters<CritiqueNormalizer["normalizeCritique"]>[0]) {
        return {
          personaId: raw.personaId,
          overallSummary: `${raw.personaId} summary`,
          summary: raw.text,
          claims: [],
          risks: [],
          questions: [],
          recommendations: [],
        };
      }
    }

    await runCouncilForTest(
      { prompt: "Trace this run." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer: new TracedNormalizer(),
          judge: judge(1),
        },
      },
    );

    const rootSpan = telemetry.spans.find((span) => span.name === "council-run");
    const normalizeSpan = telemetry.spans.find((span) => span.name === "run.council.baml.normalize");
    const traceInput = rootSpan?.attributes["langfuse.trace.input"] as string;
    const traceOutput = rootSpan?.attributes["langfuse.trace.output"] as string;
    const observationInput = rootSpan?.attributes["langfuse.observation.input"] as string;
    const observationOutput = rootSpan?.attributes["langfuse.observation.output"] as string;

    expect(rootSpan?.attributes["langfuse.trace.name"]).toBe("council-run");
    expect(JSON.parse(traceInput)).toMatchObject({ prompt: "Trace this run." });
    expect(JSON.parse(traceOutput)).toMatchObject({ recommendation: "Use Flue for v0." });
    expect(JSON.parse(observationInput)).toMatchObject({ prompt: "Trace this run." });
    expect(JSON.parse(observationOutput)).toMatchObject({ recommendation: "Use Flue for v0." });
    expect(normalizeSpan?.attributes).not.toHaveProperty("langfuse.trace.name");
    expect(normalizeSpan?.attributes).not.toHaveProperty("langfuse.trace.input");
    expect(normalizeSpan?.attributes).not.toHaveProperty("langfuse.trace.output");
  });

  it("records run failures on the root OTEL span", async () => {
    await expect(
      runCouncilForTest(
        { prompt: "Fail the run." },
        {
          deps: {
            personaSelector: {
              async choosePersonas() {
                throw new Error("chooser unavailable");
              },
            },
            personaWorker: fakeWorker(),
            normalizer,
            judge: judge(1),
          },
        },
      ),
    ).rejects.toThrow("chooser unavailable");

    const rootSpan = telemetry.spans.find((span) => span.name === "council-run");

    expect(rootSpan?.exceptions).toHaveLength(1);
    expect(rootSpan?.status).toContainEqual({
      code: 2,
      message: "chooser unavailable",
    });
    expect(rootSpan?.events).toContainEqual(
      expect.objectContaining({
        name: "council.run.failed",
      }),
    );
    expect(rootSpan?.ended).toBe(true);
  });

  it("claims and closes a work item only when work queue options are supplied", async () => {
    const events: string[] = [];
    const backend = {
      async ready() {
        return [];
      },
      async show() {
        throw new Error("not used");
      },
      async claim(id: string) {
        events.push(`claim:${id}`);
        return { id, title: "x", status: "in_progress" as const, type: "task" as const, priority: 1, labels: [], dependencies: [] };
      },
      async create() {
        throw new Error("not used");
      },
      async close(id: string, input: { reason: string }) {
        events.push(`close:${id}:${input.reason}`);
        return { id, title: "x", status: "closed" as const, type: "task" as const, priority: 1, labels: [], dependencies: [] };
      },
      async sync() {
        events.push("sync");
      },
    };

    await runDecisionCouncil(
      { prompt: "Handle a work item." },
      {
        outputDir: "runs/work-item",
        workQueue: {
          backend,
          workItemId: "bd-root",
          claimOnStart: true,
          closeOnSuccess: true,
          syncOnComplete: true,
        },
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
          writeArtifacts: false,
        },
      },
    );

    expect(events[0]).toBe("claim:bd-root");
    expect(events[1]).toContain("close:bd-root:Decision Council completed.");
    expect(events[2]).toBe("sync");
  });
});

describe("createDecisionCouncilWorkflow", () => {
  it("returns a workflow object without throwing when called with valid deps", () => {
    expect(() =>
      createDecisionCouncilWorkflow({
        personaSelector: staticDefaultSelector,
        personaWorker: fakeWorker(),
        normalizer,
        judge: judge(1),
      }),
    ).not.toThrow();
  });

  it("createDecisionCouncilWorkflow accepts Flue agent tools without requiring live MCP servers", () => {
    const tool = { name: "mcp__EngHub__search" };

    expect(() =>
      createDecisionCouncilWorkflow(
        {
          personaSelector: staticDefaultSelector,
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
        },
        { flueTools: [tool as never], flueModel: "github-copilot/gpt-4o" },
      ),
    ).not.toThrow();
  });
});

describe("telemetry deps", () => {
  it("loads OpenTelemetry API package", () => {
    expect(trace.getTracer).toBeTypeOf("function");
  });
});
