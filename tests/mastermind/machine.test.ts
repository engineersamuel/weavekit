import { describe, expect, it } from "vitest";
import {
  eventForRecommendedAction,
  transitionMastermindState,
} from "../../src/mastermind/domain/machine.js";
import {
  MastermindAction,
  MastermindEventType,
  MastermindState,
} from "../../src/mastermind/domain/events.js";

describe("Mastermind state machine", () => {
  it("moves an unreviewed item through review and back to deciding", () => {
    const claimed = transitionMastermindState(MastermindState.RECEIVED, {
      type: MastermindEventType.CLAIM,
    });
    const deciding = transitionMastermindState(claimed, {
      type: MastermindEventType.DECIDE,
    });
    const reviewing = transitionMastermindState(
      deciding,
      eventForRecommendedAction(MastermindAction.REVIEW_TICKET, [MastermindAction.REVIEW_TICKET]),
    );
    const applying = transitionMastermindState(reviewing, {
      type: MastermindEventType.REVIEW_GENERATED,
    });
    const decidedAgain = transitionMastermindState(applying, {
      type: MastermindEventType.REVIEW_APPLIED,
    });

    expect(decidedAgain).toBe(MastermindState.DECIDING);
  });

  it("plans future implementation without executing it", () => {
    const event = eventForRecommendedAction(MastermindAction.DELEGATE_SUBMIND, [
      MastermindAction.DELEGATE_SUBMIND,
    ]);

    expect(transitionMastermindState(MastermindState.DECIDING, event)).toBe(
      MastermindState.ACTION_PLANNED,
    );
  });

  it("moves direct execution through every durable phase", () => {
    const provisioning = transitionMastermindState(MastermindState.ACTION_PLANNED, {
      type: MastermindEventType.BEGIN_EXECUTION,
    });
    const preflighting = transitionMastermindState(provisioning, {
      type: MastermindEventType.WORKSPACE_PROVISIONED,
    });
    const launching = transitionMastermindState(preflighting, {
      type: MastermindEventType.PREFLIGHT_PASSED,
    });
    const running = transitionMastermindState(launching, {
      type: MastermindEventType.EXECUTOR_STARTED,
    });
    const collecting = transitionMastermindState(running, {
      type: MastermindEventType.EXECUTOR_TERMINAL,
    });

    expect(
      transitionMastermindState(collecting, {
        type: MastermindEventType.EXECUTION_SUCCEEDED,
      }),
    ).toBe(MastermindState.SUCCEEDED);
  });

  it("does not allow execution phases to be skipped", () => {
    expect(() =>
      transitionMastermindState(MastermindState.ACTION_PLANNED, {
        type: MastermindEventType.PREFLIGHT_PASSED,
      }),
    ).toThrow("Invalid Mastermind transition");
    expect(() =>
      transitionMastermindState(MastermindState.RUNNING, {
        type: MastermindEventType.EXECUTION_SUCCEEDED,
      }),
    ).toThrow("Invalid Mastermind transition");
  });

  it("routes a blocked review patch to human input", () => {
    expect(
      transitionMastermindState(MastermindState.APPLYING_REVIEW, {
        type: MastermindEventType.REQUIRE_HUMAN,
      }),
    ).toBe(MastermindState.NEEDS_HUMAN);
  });

  it("reopens terminal review states after later human changes", () => {
    expect(
      transitionMastermindState(MastermindState.ACTION_PLANNED, {
        type: MastermindEventType.REOPEN_REVIEW,
      }),
    ).toBe(MastermindState.REVIEWING);
    expect(
      transitionMastermindState(MastermindState.SUCCEEDED, {
        type: MastermindEventType.REOPEN_REVIEW,
      }),
    ).toBe(MastermindState.REVIEWING);
  });

  it("starts a new execution attempt from retry wait", () => {
    expect(
      transitionMastermindState(MastermindState.RETRY_WAIT, {
        type: MastermindEventType.BEGIN_EXECUTION,
      }),
    ).toBe(MastermindState.PROVISIONING);
  });

  it("allows an operator to retry terminal execution failures", () => {
    expect(
      transitionMastermindState(MastermindState.NEEDS_HUMAN, {
        type: MastermindEventType.RETRY,
      }),
    ).toBe(MastermindState.RETRY_WAIT);
    expect(
      transitionMastermindState(MastermindState.FAILED, {
        type: MastermindEventType.RETRY,
      }),
    ).toBe(MastermindState.RETRY_WAIT);
  });

  it("fails closed when policy does not allow the recommendation", () => {
    const event = eventForRecommendedAction(MastermindAction.IMPLEMENT_DIRECTLY, [
      MastermindAction.REVIEW_TICKET,
    ]);

    expect(transitionMastermindState(MastermindState.DECIDING, event)).toBe(
      MastermindState.NEEDS_HUMAN,
    );
  });

  it("rejects invalid transitions", () => {
    expect(() =>
      transitionMastermindState(MastermindState.RECEIVED, {
        type: MastermindEventType.REVIEW_APPLIED,
      }),
    ).toThrow("Invalid Mastermind transition");
  });
});
