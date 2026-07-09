import { describe, expect, it, vi } from "vitest";
import {
  composeDecisionCouncilLoggers,
  createOtelDecisionCouncilLogger,
  decisionCouncilEventLevel,
} from "../../src/decision-council/otelLogger.js";

describe("otel decision council logger", () => {
  it("maps council events to span events with OTEL-friendly attributes", () => {
    const addEvent = vi.fn();
    const logger = createOtelDecisionCouncilLogger({
      span: {
        addEvent,
      },
    });

    logger.event({
      type: "council.persona.completed",
      timestamp: "2026-06-26T20:00:00.000Z",
      runId: "run-1",
      roundNumber: 2,
      personaId: "skeptic",
      model: "claude-sonnet-4.6",
      durationMs: 123,
    });

    expect(addEvent).toHaveBeenCalledWith(
      "council.persona.completed",
      expect.objectContaining({
        level: "debug",
        message: "persona completed",
        timestamp: "2026-06-26T20:00:00.000Z",
        runId: "run-1",
        roundNumber: 2,
        personaId: "skeptic",
        model: "claude-sonnet-4.6",
        durationMs: 123,
      }),
    );
  });

  it("marks failed events as errors", () => {
    expect(
      decisionCouncilEventLevel({
        type: "council.run.failed",
        timestamp: "2026-06-26T20:00:00.000Z",
        runId: "run-1",
        durationMs: 12,
        error: "boom",
      }),
    ).toBe("error");
  });

  it("can fan out to multiple logger sinks without changing payloads", () => {
    const first = vi.fn();
    const second = vi.fn();
    const logger = composeDecisionCouncilLoggers({ event: first }, { event: second });
    const event = {
      type: "council.run.started" as const,
      timestamp: "2026-06-26T20:00:00.000Z",
      runId: "run-1",
      personaCount: 4,
      maxRounds: 3,
    };

    logger.event(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });
});
