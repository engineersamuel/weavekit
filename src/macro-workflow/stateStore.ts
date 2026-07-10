import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MacroWorkflowRunStateLike } from "./types.js";

export const WORKFLOW_STATE_SCHEMA_VERSION = 1;

export type MacroWorkflowStateStoreOptions = {
  lockRetryMs?: number;
  lockTimeoutMs?: number;
};

const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const SENSITIVE_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apikey",
  "authorization",
  "accesstoken",
]);
const DATE_KEYS = new Set(["startedAt", "completedAt", "lastUpdatedAt", "timestamp"]);

export class MacroWorkflowStateStore {
  readonly statePath: string;
  readonly lockPath: string;
  private readonly outputDir: string;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;

  constructor(outputDir: string, options: MacroWorkflowStateStoreOptions = {}) {
    this.outputDir = outputDir;
    this.statePath = join(outputDir, "workflow-state.json");
    this.lockPath = `${this.statePath}.lock`;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async read(): Promise<MacroWorkflowRunStateLike> {
    const [contents, fileStats] = await Promise.all([
      readFile(this.statePath, "utf8"),
      stat(this.statePath),
    ]);
    const parsed = JSON.parse(contents, reviveStateDate) as MacroWorkflowRunStateLike;
    const schemaVersion = parsed.schemaVersion ?? 0;
    if (schemaVersion > WORKFLOW_STATE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported workflow state schema version ${schemaVersion}; this weavekit supports up to ${WORKFLOW_STATE_SCHEMA_VERSION}.`,
      );
    }
    if (schemaVersion < 0 || !Number.isInteger(schemaVersion)) {
      throw new Error(`Invalid workflow state schema version: ${String(schemaVersion)}.`);
    }

    return {
      ...parsed,
      schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
      runId: parsed.runId ?? basename(this.outputDir),
      lastUpdatedAt: parsed.lastUpdatedAt ?? fileStats.mtime,
    };
  }

  async write(state: MacroWorkflowRunStateLike): Promise<string> {
    assertNoSensitiveState(state);
    await mkdir(this.outputDir, { recursive: true });
    const release = await this.acquireLock();
    const temporaryPath = join(
      this.outputDir,
      `.workflow-state.json.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      const persistedState: MacroWorkflowRunStateLike = {
        ...state,
        schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
        runId: state.runId ?? basename(this.outputDir),
        lastUpdatedAt: new Date(),
      };
      await writeFile(temporaryPath, JSON.stringify(persistedState, null, 2), "utf8");
      await rename(temporaryPath, this.statePath);
      return this.statePath;
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } finally {
        await release();
      }
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx");
        return async () => {
          try {
            await handle.close();
          } finally {
            await rm(this.lockPath, { force: true });
          }
        };
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(
            `Timed out acquiring workflow state lock after ${this.lockTimeoutMs}ms: ${this.lockPath}`,
          );
        }
        await delay(this.lockRetryMs);
      }
    }
  }
}

function reviveStateDate(key: string, value: unknown): unknown {
  if (DATE_KEYS.has(key) && typeof value === "string") {
    return new Date(value);
  }
  return value;
}

function assertNoSensitiveState(
  value: unknown,
  path = "state",
  seen = new WeakSet<object>(),
): void {
  if (!value || typeof value !== "object" || value instanceof Date) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveState(entry, `${path}[${index}]`, seen));
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizeSensitiveKey(key))) {
      throw new Error(`Refusing to persist sensitive workflow state key: ${path}.${key}`);
    }
    assertNoSensitiveState(entry, `${path}.${key}`, seen);
  }
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[_-]/gu, "").toLowerCase();
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
