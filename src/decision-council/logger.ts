import pc from "picocolors";
import prettyjson from "prettyjson";

export type DecisionCouncilEvent =
  | {
      type: "council.run.started";
      timestamp: string;
      runId: string;
      traceId?: string;
      inputPath?: string;
      outputDir?: string;
      personaCount: number;
      maxRounds: number;
    }
  | {
      type: "council.round.started";
      timestamp: string;
      runId: string;
      roundNumber: number;
      focus: string;
      focusSource: "initial" | "judge";
      previousRoundNumber?: number;
    }
  | {
      type: "council.personas.started";
      timestamp: string;
      runId: string;
      roundNumber: number;
      candidatePersonaCount: number;
    }
  | {
      type: "council.personas.completed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      personaIds: string[];
      rationale: string;
      durationMs: number;
    }
  | {
      type: "council.personas.failed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      durationMs: number;
      error: string;
    }
  | {
      type: "council.persona.started" | "council.persona.completed" | "council.persona.failed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      personaId: string;
      skill?: string;
      model?: string;
      durationMs?: number;
      error?: string;
    }
  | {
      type: "council.baml.started" | "council.baml.completed" | "council.baml.failed";
      timestamp: string;
      runId: string;
      roundNumber?: number;
      operation: "normalize" | "assess" | "report";
      personaId?: string;
      model?: string;
      durationMs?: number;
      summary?: string;
      error?: string;
    }
  | {
      type: "council.round.completed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      successfulPersonas: number;
      failedPersonas: number;
      confidence: number;
      convergence: number;
      shouldContinue: boolean;
      durationMs: number;
    }
  | {
      type: "council.artifacts.written";
      timestamp: string;
      runId: string;
      reportPath: string;
      statePath: string;
      debugTranscriptCount: number;
    }
  | {
      type: "council.run.completed" | "council.run.failed";
      timestamp: string;
      runId: string;
      traceId?: string;
      stopReason?: string;
      durationMs: number;
      error?: string;
    };

export type DecisionCouncilLogger = {
  event(event: DecisionCouncilEvent): void;
};

type LoggerOptions = {
  write?: (message: string) => void;
};

type FormatOptions = {
  color?: boolean;
};

const noopWrite = () => undefined;

export function timestamp(): string {
  return new Date().toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function label(event: DecisionCouncilEvent): string {
  return event.type.replace(/^council\./, "").replaceAll(".", " ");
}

function colorize(event: DecisionCouncilEvent, text: string, enabled: boolean): string {
  const colors = pc.createColors(enabled);
  if (!enabled) return text;
  if (event.type.endsWith(".failed")) return colors.red(text);
  if (event.type.endsWith(".completed") || event.type === "council.artifacts.written")
    return colors.green(text);
  if (event.type.endsWith(".started")) return colors.cyan(text);
  return colors.bold(text);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}

function eventDetails(event: DecisionCouncilEvent): Record<string, unknown> {
  const { type: _type, timestamp: _timestamp, ...rest } = event;
  const details: Record<string, unknown> = { ...rest };
  if (typeof details.durationMs === "number") {
    details.duration = seconds(details.durationMs);
    delete details.durationMs;
  }
  return details;
}

export function formatDecisionCouncilEvent(
  event: DecisionCouncilEvent,
  options: FormatOptions = {},
): string {
  const color = options.color ?? pc.isColorSupported;
  const colors = pc.createColors(color);
  const header = `${colors.gray(`[${event.timestamp}]`)} ${colorize(event, label(event), color)}`;
  const body = prettyjson.render(eventDetails(event), { noColor: !color });
  return body.length > 0 ? `${header}\n${indent(body)}` : header;
}

export function createConsoleDecisionCouncilLogger(
  options: LoggerOptions & FormatOptions = {},
): DecisionCouncilLogger {
  const write = options.write ?? ((message) => process.stderr.write(message));
  return {
    event(event) {
      write(`${formatDecisionCouncilEvent(event, { color: options.color })}\n`);
    },
  };
}

export function createJsonDecisionCouncilLogger(
  options: LoggerOptions = {},
): DecisionCouncilLogger {
  const write = options.write ?? ((message) => process.stderr.write(message));
  return {
    event(event) {
      write(`${JSON.stringify(event)}\n`);
    },
  };
}

export function createSilentDecisionCouncilLogger(
  options: LoggerOptions = {},
): DecisionCouncilLogger {
  const write = options.write ?? noopWrite;
  return {
    event() {
      void write;
    },
  };
}
