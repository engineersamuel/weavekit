import { createActor, setup } from "xstate";
import {
  MastermindAction,
  MastermindEventType,
  MastermindState,
  type MastermindEvent,
  type MastermindState as MastermindStateValue,
} from "./events.js";

export const mastermindMachine = setup({
  types: {
    events: {} as MastermindEvent,
  },
}).createMachine({
  id: "mastermind-work-item",
  initial: MastermindState.RECEIVED,
  states: {
    [MastermindState.RECEIVED]: {
      on: {
        [MastermindEventType.CLAIM]: MastermindState.CLAIMED,
        [MastermindEventType.FAIL]: MastermindState.FAILED,
      },
    },
    [MastermindState.CLAIMED]: {
      on: {
        [MastermindEventType.DECIDE]: MastermindState.DECIDING,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.FAIL]: MastermindState.FAILED,
      },
    },
    [MastermindState.DECIDING]: {
      on: {
        [MastermindEventType.REVIEW]: MastermindState.REVIEWING,
        [MastermindEventType.PLAN_ACTION]: MastermindState.ACTION_PLANNED,
        [MastermindEventType.REQUIRE_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.IGNORE]: MastermindState.IGNORED,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.FAIL]: MastermindState.FAILED,
      },
    },
    [MastermindState.REVIEWING]: {
      on: {
        [MastermindEventType.REVIEW_GENERATED]: MastermindState.APPLYING_REVIEW,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.FAIL]: MastermindState.FAILED,
      },
    },
    [MastermindState.APPLYING_REVIEW]: {
      on: {
        [MastermindEventType.REVIEW_APPLIED]: MastermindState.DECIDING,
        [MastermindEventType.REVIEW_INVALIDATED]: MastermindState.REVIEWING,
        [MastermindEventType.REQUIRE_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.FAIL]: MastermindState.FAILED,
      },
    },
    [MastermindState.RETRY_WAIT]: {
      on: {
        [MastermindEventType.RETRY_READY]: MastermindState.CLAIMED,
        [MastermindEventType.BEGIN_EXECUTION]: MastermindState.PROVISIONING,
        [MastermindEventType.EXECUTION_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.FAIL]: MastermindState.FAILED,
      },
    },
    [MastermindState.ACTION_PLANNED]: {
      on: {
        [MastermindEventType.BEGIN_EXECUTION]: MastermindState.PROVISIONING,
        [MastermindEventType.REOPEN_REVIEW]: MastermindState.REVIEWING,
      },
    },
    [MastermindState.PROVISIONING]: {
      on: {
        [MastermindEventType.WORKSPACE_PROVISIONED]: MastermindState.PREFLIGHTING,
        [MastermindEventType.EXECUTION_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.EXECUTION_FAILED]: MastermindState.FAILED,
      },
    },
    [MastermindState.PREFLIGHTING]: {
      on: {
        [MastermindEventType.PREFLIGHT_PASSED]: MastermindState.LAUNCHING,
        [MastermindEventType.EXECUTION_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.EXECUTION_FAILED]: MastermindState.FAILED,
      },
    },
    [MastermindState.LAUNCHING]: {
      on: {
        [MastermindEventType.EXECUTOR_STARTED]: MastermindState.RUNNING,
        [MastermindEventType.CANCELLATION_CONFIRMED]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.EXECUTION_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.EXECUTION_FAILED]: MastermindState.FAILED,
      },
    },
    [MastermindState.RUNNING]: {
      on: {
        [MastermindEventType.EXECUTOR_TERMINAL]: MastermindState.COLLECTING,
        [MastermindEventType.CANCELLATION_CONFIRMED]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.EXECUTION_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
        [MastermindEventType.EXECUTION_FAILED]: MastermindState.FAILED,
      },
    },
    [MastermindState.COLLECTING]: {
      on: {
        [MastermindEventType.EXECUTION_SUCCEEDED]: MastermindState.SUCCEEDED,
        [MastermindEventType.EXECUTION_RETRYABLE]: MastermindState.RETRY_WAIT,
        [MastermindEventType.EXECUTION_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
        [MastermindEventType.EXECUTION_FAILED]: MastermindState.FAILED,
      },
    },
    [MastermindState.SUCCEEDED]: {
      on: {
        [MastermindEventType.BEGIN_CODE_REVIEW]: MastermindState.CODE_REVIEW_PENDING,
        [MastermindEventType.REOPEN_REVIEW]: MastermindState.REVIEWING,
      },
    },
    [MastermindState.CODE_REVIEW_PENDING]: {
      on: {
        [MastermindEventType.CODE_REVIEW_STARTED]: MastermindState.CODE_REVIEWING,
        [MastermindEventType.CODE_REVIEW_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
      },
    },
    [MastermindState.CODE_REVIEWING]: {
      on: {
        [MastermindEventType.CODE_REVIEW_PASSED]: MastermindState.AWAITING_ACCEPTANCE,
        [MastermindEventType.CODE_CHANGES_REQUESTED]: MastermindState.CHANGES_REQUESTED,
        [MastermindEventType.CODE_REVIEW_NEEDS_HUMAN]: MastermindState.NEEDS_HUMAN,
      },
    },
    [MastermindState.AWAITING_ACCEPTANCE]: {
      on: {
        [MastermindEventType.ACCEPT_IMPLEMENTATION]: MastermindState.COMPLETED,
        [MastermindEventType.CODE_CHANGES_REQUESTED]: MastermindState.CHANGES_REQUESTED,
      },
    },
    [MastermindState.CHANGES_REQUESTED]: {
      on: {
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
      },
    },
    [MastermindState.COMPLETED]: { type: "final" },
    [MastermindState.NEEDS_HUMAN]: {
      on: {
        [MastermindEventType.REOPEN_REVIEW]: MastermindState.REVIEWING,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
      },
    },
    [MastermindState.IGNORED]: { type: "final" },
    [MastermindState.FAILED]: {
      on: {
        [MastermindEventType.REOPEN_REVIEW]: MastermindState.REVIEWING,
        [MastermindEventType.RETRY]: MastermindState.RETRY_WAIT,
      },
    },
  },
});

export function transitionMastermindState(
  currentState: MastermindStateValue,
  event: MastermindEvent,
): MastermindStateValue {
  const actor = createActor(mastermindMachine, {
    snapshot: mastermindMachine.resolveState({
      value: currentState,
      context: {},
    }),
  });
  actor.start();
  actor.send(event);
  const nextState = actor.getSnapshot().value;
  actor.stop();
  if (typeof nextState !== "string" || nextState === currentState) {
    throw new Error(`Invalid Mastermind transition: ${currentState} + ${event.type}`);
  }
  return nextState as MastermindStateValue;
}

export function eventForRecommendedAction(
  action: MastermindAction,
  allowedActions: readonly MastermindAction[],
): MastermindEvent {
  if (!allowedActions.includes(action)) {
    return { type: MastermindEventType.REQUIRE_HUMAN };
  }
  switch (action) {
    case MastermindAction.REVIEW_TICKET:
      return { type: MastermindEventType.REVIEW };
    case MastermindAction.IMPLEMENT_DIRECTLY:
    case MastermindAction.DELEGATE_SUBMIND:
    case MastermindAction.WAIT:
      return { type: MastermindEventType.PLAN_ACTION };
    case MastermindAction.NEEDS_HUMAN:
      return { type: MastermindEventType.REQUIRE_HUMAN };
    case MastermindAction.IGNORE:
      return { type: MastermindEventType.IGNORE };
  }
}
