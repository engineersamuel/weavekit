import type { Attributes, Span } from "@opentelemetry/api";
import type { DecisionCouncilEvent, DecisionCouncilLogger } from "./logger.js";

type OtelLoggerOptions = {
  span?: Pick<Span, "addEvent">;
};

function eventLabel(event: DecisionCouncilEvent): string {
  return event.type.replace(/^council\./, "").replaceAll(".", " ");
}

export function decisionCouncilEventLevel(event: DecisionCouncilEvent): "debug" | "info" | "error" {
  if (event.type.endsWith(".failed")) return "error";
  if (
    event.type === "council.persona.started" ||
    event.type === "council.persona.completed" ||
    event.type === "council.baml.started" ||
    event.type === "council.baml.completed"
  ) {
    return "debug";
  }
  return "info";
}

export function decisionCouncilEventAttributes(event: DecisionCouncilEvent): Attributes {
  const { type: _type, ...rest } = event;
  const attributes: Attributes = {
    level: decisionCouncilEventLevel(event),
    message: eventLabel(event),
    timestamp: event.timestamp,
  };

  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      attributes[key] = value;
    }
  }

  return attributes;
}

export function createOtelDecisionCouncilLogger(options: OtelLoggerOptions): DecisionCouncilLogger {
  return {
    event(event) {
      options.span?.addEvent(event.type, decisionCouncilEventAttributes(event));
    },
  };
}

export function composeDecisionCouncilLoggers(
  ...loggers: Array<DecisionCouncilLogger | undefined>
): DecisionCouncilLogger {
  return {
    event(event) {
      for (const logger of loggers) {
        logger?.event(event);
      }
    },
  };
}
