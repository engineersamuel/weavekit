import pc from "picocolors";

export type DecisionCouncilEvent =
  | {
      type: "council.run.started";
      timestamp: string;
      runId: string;
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
      type: "council.persona.started" | "council.persona.completed" | "council.persona.failed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      personaId: string;
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
  if (event.type.endsWith(".completed") || event.type === "council.artifacts.written") return colors.green(text);
  if (event.type.endsWith(".started")) return colors.cyan(text);
  return colors.bold(text);
}

function childLine(text: string): string {
  return `\n    -> ${text}`;
}

function childText(event: DecisionCouncilEvent): string | undefined {
  if (event.type === "council.baml.completed" && event.operation === "normalize" && event.summary) {
    return event.summary;
  }

  if (event.type === "council.round.started" && event.focusSource === "judge" && event.previousRoundNumber) {
    return `Shared Judge brief from round ${event.previousRoundNumber}; all personas respond to this focus, then the Judge assesses the round ${event.roundNumber} set together.`;
  }

  if (event.type === "council.round.started" && event.focusSource === "initial") {
    return "Initial council brief; all personas respond independently, then the Judge assesses the round 1 set together.";
  }

  return undefined;
}

export function formatDecisionCouncilEvent(event: DecisionCouncilEvent, options: FormatOptions = {}): string {
  const color = options.color ?? pc.isColorSupported;
  const colors = pc.createColors(color);
  const title = colorize(event, label(event), color);
  const parts = [colors.gray(`[${event.timestamp}]`), title];

  if ("roundNumber" in event && event.roundNumber !== undefined) parts.push(`round=${event.roundNumber}`);
  if ("personaId" in event && event.personaId) parts.push(`persona=${event.personaId}`);
  if ("operation" in event) parts.push(`operation=${event.operation}`);
  if ("model" in event && event.model) parts.push(`model=${event.model}`);
  if ("durationMs" in event && typeof event.durationMs === "number") parts.push(`duration=${seconds(event.durationMs)}`);

  switch (event.type) {
    case "council.run.started":
      parts.push(`personas=${event.personaCount}`, `maxRounds=${event.maxRounds}`);
      if (event.inputPath) parts.push(`input=${event.inputPath}`);
      if (event.outputDir) parts.push(`output=${event.outputDir}`);
      break;
    case "council.round.started":
      parts.push(`focus=${JSON.stringify(event.focus)}`);
      break;
    case "council.round.completed":
      parts.push(
        `successful=${event.successfulPersonas}`,
        `failed=${event.failedPersonas}`,
        `confidence=${event.confidence.toFixed(2)}`,
        `convergence=${event.convergence.toFixed(2)}`,
        `continue=${event.shouldContinue}`,
      );
      break;
    case "council.artifacts.written":
      parts.push(`report=${event.reportPath}`, `state=${event.statePath}`, `debugTranscripts=${event.debugTranscriptCount}`);
      break;
    case "council.run.completed":
      if (event.stopReason) parts.push(`stopReason=${event.stopReason}`);
      break;
    case "council.persona.failed":
    case "council.baml.failed":
    case "council.run.failed":
      if (event.error) parts.push(`error=${JSON.stringify(event.error)}`);
      break;
  }

  const child = childText(event);
  return child ? `${parts.join(" ")}${childLine(child)}` : parts.join(" ");
}

export function createConsoleDecisionCouncilLogger(options: LoggerOptions & FormatOptions = {}): DecisionCouncilLogger {
  const write = options.write ?? ((message) => process.stderr.write(message));
  return {
    event(event) {
      write(`${formatDecisionCouncilEvent(event, { color: options.color })}\n`);
    },
  };
}

export function createJsonDecisionCouncilLogger(options: LoggerOptions = {}): DecisionCouncilLogger {
  const write = options.write ?? ((message) => process.stderr.write(message));
  return {
    event(event) {
      write(`${JSON.stringify(event)}\n`);
    },
  };
}

export function createSilentDecisionCouncilLogger(options: LoggerOptions = {}): DecisionCouncilLogger {
  const write = options.write ?? noopWrite;
  return {
    event() {
      void write;
    },
  };
}
