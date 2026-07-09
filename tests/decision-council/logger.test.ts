import { describe, expect, it, vi } from "vitest";
import {
  createConsoleDecisionCouncilLogger,
  createJsonDecisionCouncilLogger,
  createSilentDecisionCouncilLogger,
  formatDecisionCouncilEvent,
  type DecisionCouncilEvent,
} from "../../src/decision-council/logger.js";

describe("council logger", () => {
  const event: DecisionCouncilEvent = {
    type: "council.persona.completed",
    timestamp: "2026-06-24T18:00:00.000Z",
    runId: "run-1",
    roundNumber: 1,
    personaId: "skeptic",
    durationMs: 1234,
  };

  it("formats progress events with readable labels and colors", () => {
    const formatted = formatDecisionCouncilEvent(event, { color: true });

    expect(formatted).toContain("persona completed");
    expect(formatted).toContain("skeptic");
    expect(formatted).toContain("1.2s");
    expect(formatted).toContain("\u001B[");
  });

  it("writes newline-delimited JSON events", () => {
    const write = vi.fn();
    const logger = createJsonDecisionCouncilLogger({ write });

    logger.event(event);

    expect(write).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`);
  });

  it("can silence progress output", () => {
    const write = vi.fn();
    const logger = createSilentDecisionCouncilLogger({ write });

    logger.event(event);

    expect(write).not.toHaveBeenCalled();
  });

  it("writes pretty events to stderr by default", () => {
    const write = vi.fn();
    const logger = createConsoleDecisionCouncilLogger({ write, color: false });

    logger.event(event);

    expect(write.mock.calls[0]![0]).toContain("persona completed");
  });

  it("renders normalized critique summaries as a prettyjson detail block", () => {
    const formatted = formatDecisionCouncilEvent(
      {
        type: "council.baml.completed",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 1,
        personaId: "pragmatic",
        operation: "normalize",
        durationMs: 4500,
        summary:
          "Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.",
      },
      { color: false },
    );

    expect(formatted).toContain("[2026-06-24T18:00:00.000Z] baml completed");
    expect(formatted).toContain("operation:");
    expect(formatted).toContain("normalize");
    expect(formatted).toContain("duration:");
    expect(formatted).toContain("4.5s");
    expect(formatted).toContain(
      "Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.",
    );
  });

  it("decorates baml and persona events with the model in use", () => {
    const bamlLine = formatDecisionCouncilEvent(
      {
        type: "council.baml.completed",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 1,
        personaId: "pragmatic",
        operation: "normalize",
        model: "claude-haiku-4-5",
        durationMs: 5000,
      },
      { color: false },
    );

    expect(bamlLine).toContain("baml completed");
    expect(bamlLine).toContain("model:");
    expect(bamlLine).toContain("claude-haiku-4-5");
    expect(bamlLine).toContain("5.0s");

    const personaLine = formatDecisionCouncilEvent(
      {
        type: "council.persona.completed",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 1,
        personaId: "skeptic",
        model: "claude-sonnet-4.5",
        durationMs: 1234,
      },
      { color: false },
    );

    expect(personaLine).toContain("persona completed");
    expect(personaLine).toContain("model:");
    expect(personaLine).toContain("claude-sonnet-4.5");
    expect(personaLine).toContain("1.2s");
  });

  it("omits the model field when no model is present", () => {
    expect(formatDecisionCouncilEvent(event, { color: false })).not.toContain("model:");
  });
});
