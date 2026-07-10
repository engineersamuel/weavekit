import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { MacroWorkflowRunStateLike } from "./types.js";

export const WORKFLOW_STATE_SCHEMA_VERSION = 1;

export type MacroWorkflowStateStoreOptions = {
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  staleLockThresholdMs?: number;
  testHooks?: MacroWorkflowStateStoreTestHooks;
};

export type MacroWorkflowStateStoreTestHooks = {
  beforeReclaim?: (ownerPath: string) => void | Promise<void>;
  afterReclaimAttempt?: (ownerPath: string) => void | Promise<void>;
  onLockAcquired?: (ownerPath: string) => void | Promise<void>;
  beforeLockRelease?: (ownerPath: string) => void | Promise<void>;
};

const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_THRESHOLD_MS = 5 * 60_000;
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
  private readonly staleLockThresholdMs: number;
  private readonly testHooks: MacroWorkflowStateStoreTestHooks | undefined;

  constructor(outputDir: string, options: MacroWorkflowStateStoreOptions = {}) {
    this.outputDir = outputDir;
    this.statePath = join(outputDir, "workflow-state.json");
    this.lockPath = `${this.statePath}.lock`;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockThresholdMs = options.staleLockThresholdMs ?? DEFAULT_STALE_LOCK_THRESHOLD_MS;
    this.testHooks = options.testHooks;
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
    assertNoSensitiveMacroWorkflowData(state);
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
        await mkdir(this.lockPath);
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error;
        }
        if (await this.reclaimStaleLockIfSafe()) {
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(
            `Timed out acquiring workflow state lock after ${this.lockTimeoutMs}ms: ${this.lockPath}`,
          );
        }
        await delay(this.lockRetryMs);
        continue;
      }

      const release = await this.initializeLockOwner();
      if (release) {
        return release;
      }
    }
  }

  private async initializeLockOwner(): Promise<(() => Promise<void>) | undefined> {
    const ownerPath = join(this.lockPath, `owner-${process.pid}-${randomUUID()}.json`);
    let handle;
    try {
      handle = await open(ownerPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        "utf8",
      );
      await handle.sync();
      await this.testHooks?.onLockAcquired?.(ownerPath);
    } catch (error) {
      await handle?.close();
      await unlink(ownerPath).catch(ignoreMissingPath);
      await rmdir(this.lockPath).catch(ignoreMissingOrNonEmptyDirectory);
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }

    return async () => {
      try {
        await this.testHooks?.beforeLockRelease?.(ownerPath);
      } finally {
        try {
          await handle.close();
        } finally {
          await unlink(ownerPath).catch(ignoreMissingPath);
          await rmdir(this.lockPath).catch(ignoreMissingPath);
        }
      }
    };
  }

  private async reclaimStaleLockIfSafe(): Promise<boolean> {
    let lockStats;
    try {
      lockStats = await stat(this.lockPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      throw error;
    }

    if (!lockStats.isDirectory()) {
      return this.reclaimLegacyFileLockIfSafe(lockStats);
    }

    let entries;
    try {
      entries = await readdir(this.lockPath, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      throw error;
    }
    const ownerEntries = entries.filter(
      (entry) => entry.isFile() && /^owner-.+\.json$/u.test(entry.name),
    );
    if (ownerEntries.length === 0 && entries.length === 0) {
      if (Date.now() - lockStats.mtimeMs < this.staleLockThresholdMs) {
        return false;
      }
      return this.reclaimEmptyLockDirectory();
    }
    if (ownerEntries.length !== 1 || entries.length !== 1) {
      return false;
    }

    const ownerPath = join(this.lockPath, ownerEntries[0]!.name);
    let ownerStats;
    try {
      ownerStats = await stat(ownerPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      throw error;
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(ownerPath, "utf8"));
    } catch {
      if (Date.now() - ownerStats.mtimeMs < this.staleLockThresholdMs) {
        return false;
      }
      return this.reclaimDirectoryOwner(ownerPath);
    }

    const owner = readLockOwnerMetadata(metadata);
    if (!owner) {
      if (Date.now() - ownerStats.mtimeMs < this.staleLockThresholdMs) {
        return false;
      }
      return this.reclaimDirectoryOwner(ownerPath);
    }
    if (isProcessAlive(owner.pid)) {
      return false;
    }
    return this.reclaimDirectoryOwner(ownerPath);
  }

  private async reclaimLegacyFileLockIfSafe(inspectedStats: Stats): Promise<boolean> {
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(this.lockPath, "utf8"));
    } catch {
      if (Date.now() - inspectedStats.mtimeMs < this.staleLockThresholdMs) {
        return false;
      }
      return this.removeLegacyFileLock(inspectedStats);
    }
    const owner = readLockOwnerMetadata(metadata);
    if (!owner) {
      if (Date.now() - inspectedStats.mtimeMs < this.staleLockThresholdMs) {
        return false;
      }
      return this.removeLegacyFileLock(inspectedStats);
    }
    if (isProcessAlive(owner.pid)) {
      return false;
    }
    return this.removeLegacyFileLock(inspectedStats);
  }

  private async removeLegacyFileLock(inspectedStats: Stats): Promise<boolean> {
    await this.testHooks?.beforeReclaim?.(this.lockPath);
    let currentStats;
    try {
      currentStats = await stat(this.lockPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      throw error;
    }
    if (!isSameLockFile(inspectedStats, currentStats)) {
      return false;
    }
    try {
      await unlink(this.lockPath);
      return true;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      if (isDirectoryUnlinkError(error)) {
        return false;
      }
      throw error;
    } finally {
      await this.testHooks?.afterReclaimAttempt?.(this.lockPath);
    }
  }

  private async reclaimDirectoryOwner(ownerPath: string): Promise<boolean> {
    await this.testHooks?.beforeReclaim?.(ownerPath);
    try {
      await unlink(ownerPath);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }
    try {
      await rmdir(this.lockPath);
      return true;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      if (isDirectoryNotEmptyError(error)) {
        return false;
      }
      throw error;
    } finally {
      await this.testHooks?.afterReclaimAttempt?.(ownerPath);
    }
  }

  private async reclaimEmptyLockDirectory(): Promise<boolean> {
    await this.testHooks?.beforeReclaim?.(this.lockPath);
    try {
      await rmdir(this.lockPath);
      return true;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return true;
      }
      if (isDirectoryNotEmptyError(error)) {
        return false;
      }
      throw error;
    } finally {
      await this.testHooks?.afterReclaimAttempt?.(this.lockPath);
    }
  }
}

function isSameLockFile(inspected: Stats, current: Stats): boolean {
  return (
    inspected.isFile() &&
    current.isFile() &&
    inspected.dev === current.dev &&
    inspected.ino === current.ino &&
    inspected.size === current.size &&
    inspected.mtimeMs === current.mtimeMs
  );
}

function readLockOwnerMetadata(value: unknown): { pid: number; createdAt: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    return undefined;
  }
  return { pid: record.pid, createdAt: record.createdAt };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

function reviveStateDate(key: string, value: unknown): unknown {
  if (DATE_KEYS.has(key) && typeof value === "string") {
    return new Date(value);
  }
  return value;
}

export function assertNoSensitiveMacroWorkflowData(
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
    value.forEach((entry, index) =>
      assertNoSensitiveMacroWorkflowData(entry, `${path}[${index}]`, seen),
    );
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizeSensitiveKey(key))) {
      throw new Error(`Refusing to persist sensitive workflow state key: ${path}.${key}`);
    }
    assertNoSensitiveMacroWorkflowData(entry, `${path}.${key}`, seen);
  }
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[_-]/gu, "").toLowerCase();
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoCode(error, "EEXIST");
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoCode(error, "ENOENT");
}

function isDirectoryNotEmptyError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoCode(error, "ENOTEMPTY") || isErrnoCode(error, "EEXIST");
}

function isDirectoryUnlinkError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoCode(error, "EISDIR") || isErrnoCode(error, "EPERM");
}

function isErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ignoreMissingPath(error: unknown): void {
  if (!isFileNotFoundError(error)) {
    throw error;
  }
}

function ignoreMissingOrNonEmptyDirectory(error: unknown): void {
  if (!isFileNotFoundError(error) && !isDirectoryNotEmptyError(error)) {
    throw error;
  }
}
