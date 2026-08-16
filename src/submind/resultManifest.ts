import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  DirectExecutionRequest,
  DirectExecutionResult,
  VerificationEntry,
} from "./contracts.js";

/**
 * Parses and validates the transport-agnostic `.weavekit/mastermind-result.json` manifest
 * contract described by `buildDirectExecutionPrompt`. Shared by every `DirectExecutor`
 * implementation (Herdr pane, RLM/Submind detached process, ...) so the completion contract stays
 * identical regardless of which harness actually did the work.
 */
export function parseDirectExecutionResult(value: unknown): DirectExecutionResult {
  const record = asRecord(value);
  const outcome = record.outcome;
  if (
    record.schemaVersion !== 1 ||
    typeof record.workId !== "string" ||
    typeof record.attemptId !== "string" ||
    !Number.isInteger(record.attemptNumber) ||
    !["succeeded", "retryable-failure", "terminal-failure", "needs-human"].includes(
      String(outcome),
    ) ||
    typeof record.summary !== "string"
  ) {
    throw new Error("Execution result manifest has an invalid required contract.");
  }
  const verification = parseVerification(record.verification);
  if (
    outcome === "succeeded" &&
    (verification.length === 0 || verification.some((entry) => !verificationPassed(entry)))
  ) {
    throw new Error("Successful execution result requires passing verification evidence.");
  }
  const pullRequestUrl =
    typeof record.pullRequestUrl === "string" ? validateHttpsUrl(record.pullRequestUrl) : undefined;
  return {
    schemaVersion: 1,
    workId: record.workId,
    attemptId: record.attemptId,
    attemptNumber: Number(record.attemptNumber),
    outcome: outcome as DirectExecutionResult["outcome"],
    summary: record.summary.trim(),
    artifactPaths: stringArray(record.artifactPaths),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    verification,
    knownRisks: stringArray(record.knownRisks),
    remainingWork: stringArray(record.remainingWork),
  };
}

export function validateResultForRequest(
  result: DirectExecutionResult,
  request: DirectExecutionRequest,
): void {
  if (
    result.workId !== request.workId ||
    result.attemptId !== request.attemptId ||
    result.attemptNumber !== request.attemptNumber
  ) {
    throw new Error("Execution result manifest belongs to a stale or different attempt.");
  }
  if (result.pullRequestUrl && request.allowedPullRequestHosts.length > 0) {
    const host = new URL(result.pullRequestUrl).hostname.toLowerCase();
    if (!request.allowedPullRequestHosts.includes(host)) {
      throw new Error(`Execution result PR host is not allowed: ${host}`);
    }
  }
}

/** Validates that every artifact path is relative and stays contained within the worktree. */
export async function validateArtifacts(worktreePath: string, paths: string[]): Promise<void> {
  const root = await realpath(worktreePath);
  for (const artifactPath of paths) {
    if (isAbsolute(artifactPath)) {
      throw new Error("Execution artifact paths must be relative.");
    }
    const candidate = await realpath(join(root, artifactPath));
    const path = relative(root, candidate);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error(`Execution artifact escapes the worktree: ${artifactPath}`);
    }
    await stat(candidate);
  }
}

/**
 * Reads, parses, and validates the standard result manifest at
 * `<worktreePath>/.weavekit/mastermind-result.json`, throwing (including on ENOENT) if it is
 * missing or invalid. Callers that need to distinguish "no manifest yet" from "invalid manifest"
 * should check for the file's existence themselves before calling this.
 */
export async function readAndValidateResultManifest(
  worktreePath: string,
): Promise<DirectExecutionResult> {
  const manifestPath = join(worktreePath, ".weavekit", "mastermind-result.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const result = parseDirectExecutionResult(raw);
  await validateArtifacts(worktreePath, result.artifactPaths);
  return result;
}

function parseVerification(value: unknown): VerificationEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const record = asRecord(entry);
    if (
      typeof record.command !== "string" ||
      !Number.isInteger(record.exitCode) ||
      typeof record.summary !== "string" ||
      (record.expectedExitCode !== undefined && !Number.isInteger(record.expectedExitCode))
    ) {
      throw new Error("Execution verification entry is invalid.");
    }
    return {
      command: record.command,
      exitCode: Number(record.exitCode),
      summary: record.summary,
      ...(record.expectedExitCode === undefined
        ? {}
        : { expectedExitCode: Number(record.expectedExitCode) }),
    };
  });
}

/**
 * Reports whether a self-reported verification entry proves its check passed. Most commands prove
 * it with exit 0, but an entry may declare a different passing code via `expectedExitCode`.
 */
export function verificationPassed(entry: VerificationEntry): boolean {
  return entry.exitCode === (entry.expectedExitCode ?? 0);
}

function validateHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("Execution pull request URL must be HTTPS without credentials.");
  }
  return url.toString();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Execution result manifest contains an invalid string array.");
  }
  return value as string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
