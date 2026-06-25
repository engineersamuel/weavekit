import { describe, expect, it, vi } from "vitest";
import {
  createConsoleCouncilLogger,
  createJsonCouncilLogger,
  createSilentCouncilLogger,
  formatCouncilEvent,
  type CouncilEvent,
} from "../../src/council/logger.js";

describe("council logger", () => {
  const event: CouncilEvent = {
    type: "council.persona.completed",
    timestamp: "2026-06-24T18:00:00.000Z",
    runId: "run-1",
    roundNumber: 1,
    personaId: "skeptic",
    durationMs: 1234,
  };

  it("formats progress events with readable labels and colors", () => {
    const formatted = formatCouncilEvent(event, { color: true });

    expect(formatted).toContain("persona completed");
    expect(formatted).toContain("skeptic");
    expect(formatted).toContain("1.2s");
    expect(formatted).toContain("\u001B[");
  });

  it("writes newline-delimited JSON events", () => {
    const write = vi.fn();
    const logger = createJsonCouncilLogger({ write });

    logger.event(event);

    expect(write).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`);
  });

  it("can silence progress output", () => {
    const write = vi.fn();
    const logger = createSilentCouncilLogger({ write });

    logger.event(event);

    expect(write).not.toHaveBeenCalled();
  });

  it("writes pretty events to stderr by default", () => {
    const write = vi.fn();
    const logger = createConsoleCouncilLogger({ write, color: false });

    logger.event(event);

    expect(write.mock.calls[0]![0]).toContain("persona completed");
  });

  it("formats normalized critique summaries as indented child lines", () => {
    const formatted = formatCouncilEvent(
      {
        type: "council.baml.completed",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 1,
        personaId: "pragmatic",
        operation: "normalize",
        durationMs: 4500,
        summary: "Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.",
      },
      { color: false },
    );

    expect(formatted).toContain("baml completed round=1 persona=pragmatic operation=normalize duration=4.5s");
    expect(formatted).toContain(
      "\n    -> Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.",
    );
  });

  it("formats shared Judge round context as an indented child line", () => {
    const formatted = formatCouncilEvent(
      {
        type: "council.round.started",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 2,
        focus: "Focus on validation criteria.",
        focusSource: "judge",
        previousRoundNumber: 1,
      },
      { color: false },
    );

    expect(formatted).toContain('round started round=2 focus="Focus on validation criteria."');
    expect(formatted).toContain(
      "\n    -> Shared Judge brief from round 1; all personas respond to this focus, then the Judge assesses the round 2 set together.",
    );
  });
});
