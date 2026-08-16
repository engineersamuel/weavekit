import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * Narrow structural input for {@link provisionHerdrWorktree}. Deliberately not `SubmindRunState`:
 * this module is shared by `submind-poc` and `rlm-poc`'s `invoke_trellage`, and only ever needs
 * the repository, the branch to create, and labels for the resulting workspace and tab.
 */
export type ProvisionWorktreeInput = {
  sourceRepositoryPath: string;
  branchName: string;
  runId: string;
  /** Workspace label. Defaults to the historical `Submind POC <runId>` form. */
  workspaceLabel?: string;
  /** Name applied to the worktree workspace's initial tab. */
  tabLabel?: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<string>;

export type ProvisionedRun = {
  worktreePath: string;
  workspaceId: string;
  rootPaneId: string;
};

export type ExistingHerdrWorktree = Pick<ProvisionedRun, "worktreePath" | "workspaceId">;

export async function canonicalRepository(
  cwd: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  let root: string;
  try {
    root = (await runner("git", ["rev-parse", "--show-toplevel"], { cwd })).trim();
  } catch {
    throw new Error(`Not a Git repository: ${cwd}`);
  }
  if (!root) throw new Error(`Git repository root is unavailable: ${cwd}`);
  return realpath(root);
}

/**
 * Resolves the repository's *main* working tree, which may differ from `cwd`'s own.
 *
 * Herdr refuses to branch a new worktree off a linked worktree (`linked_worktree_source`: "New and
 * open worktree actions start from the repo parent workspace"). Since agents routinely already run
 * inside a Herdr worktree, provisioning has to start from the parent checkout rather than wherever
 * the caller happens to be.
 */
export async function mainRepository(
  cwd: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  let listing: string;
  try {
    listing = await runner("git", ["worktree", "list", "--porcelain"], { cwd });
  } catch {
    return canonicalRepository(cwd, runner);
  }
  // `git worktree list` always reports the main working tree first.
  const first = listing.split(/\r?\n/u).find((line) => line.startsWith("worktree "));
  const path = first?.slice("worktree ".length).trim();
  return path ? realpath(path) : canonicalRepository(cwd, runner);
}

/** Resolves the live Herdr workspace that owns exactly the supplied checkout. */
export async function resolveExistingHerdrWorktree(
  cwd: string,
  runner: CommandRunner = runCommand,
): Promise<ExistingHerdrWorktree> {
  const canonicalCheckout = await canonicalRepository(cwd, runner);
  const listed = unwrap(
    JSON.parse(await runner("herdr", ["workspace", "list"], { cwd: canonicalCheckout })),
  );
  const matches: Array<Record<string, unknown>> = [];
  for (const record of findRecords(listed)) {
    const candidate = checkoutPath(record);
    const workspaceId = readString(record, "workspace_id", "workspaceId", "id");
    if (candidate && workspaceId && (await canonicalIfExists(candidate)) === canonicalCheckout) {
      matches.push(record);
    }
  }
  const unique = uniqueBy(matches, (record) =>
    readString(record, "workspace_id", "workspaceId", "id"),
  );
  if (unique.length === 0) {
    throw new Error("Herdr has no live workspace for the current worktree.");
  }
  if (unique.length > 1) {
    throw new Error("Multiple live Herdr workspaces match the current worktree.");
  }
  const workspaceId = readString(unique[0]!, "workspace_id", "workspaceId", "id")!;
  return { worktreePath: canonicalCheckout, workspaceId };
}

export async function provisionHerdrWorktree(
  state: ProvisionWorktreeInput,
  runner: CommandRunner = runCommand,
): Promise<ProvisionedRun> {
  const listed = unwrap(
    JSON.parse(
      await runner("herdr", ["workspace", "list"], {
        cwd: state.sourceRepositoryPath,
      }),
    ),
  );
  const candidates = findRecords(listed).filter((record) => hasRepositoryPath(record));
  const exactCheckout: Array<Record<string, unknown>> = [];
  const repositoryMatches: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const checkout = checkoutPath(candidate);
    if (checkout && (await canonicalIfExists(checkout)) === state.sourceRepositoryPath) {
      exactCheckout.push(candidate);
      continue;
    }
    const path = repositoryPath(candidate);
    if (path && (await canonicalIfExists(path)) === state.sourceRepositoryPath) {
      repositoryMatches.push(candidate);
    }
  }
  const unique = uniqueBy(exactCheckout.length > 0 ? exactCheckout : repositoryMatches, (record) =>
    readString(record, "workspace_id", "workspaceId", "id"),
  );
  if (unique.length === 0) {
    throw new Error("No live Herdr workspace matches the canonical source repository path.");
  }
  if (unique.length > 1) {
    throw new Error("Multiple live Herdr workspaces match the canonical source repository path.");
  }
  const parentWorkspaceId = readString(unique[0], "workspace_id", "workspaceId", "id");
  if (!parentWorkspaceId) throw new Error("Matched Herdr workspace has no ID.");

  const worktrees = unwrap(
    JSON.parse(
      await runner("herdr", ["worktree", "list", "--workspace", parentWorkspaceId, "--json"], {
        cwd: state.sourceRepositoryPath,
      }),
    ),
  );
  const existing = findRecords(worktrees).find(
    (record) => readString(record, "branch", "branch_name", "branchName") === state.branchName,
  );
  const args = existing
    ? [
        "worktree",
        "open",
        "--workspace",
        parentWorkspaceId,
        "--branch",
        state.branchName,
        "--no-focus",
        "--json",
      ]
    : [
        "worktree",
        "create",
        "--workspace",
        parentWorkspaceId,
        "--branch",
        state.branchName,
        "--base",
        "HEAD",
        "--label",
        `${state.workspaceLabel ?? `Submind POC ${state.runId}`}`,
        "--no-focus",
        "--json",
      ];
  let opened: unknown;
  try {
    opened = unwrap(JSON.parse(await runner("herdr", args, { cwd: state.sourceRepositoryPath })));
  } catch (error) {
    if (!existing && /\b(?:already exists|already checked out)\b/iu.test(String(error))) {
      opened = unwrap(
        JSON.parse(
          await runner(
            "herdr",
            [
              "worktree",
              "open",
              "--workspace",
              parentWorkspaceId,
              "--branch",
              state.branchName,
              "--no-focus",
              "--json",
            ],
            { cwd: state.sourceRepositoryPath },
          ),
        ),
      );
    } else {
      throw error;
    }
  }
  const worktreePath =
    findString(opened, "checkout_path", "checkoutPath", "worktree_path", "path") ??
    findString(existing, "checkout_path", "checkoutPath", "worktree_path", "path");
  const workspaceId =
    findString(opened, "workspace_id", "workspaceId", "open_workspace_id") ??
    findString(existing, "workspace_id", "workspaceId", "open_workspace_id");
  let rootPaneId = findString(opened, "root_pane_id", "rootPaneId", "pane_id", "paneId");
  let initialTabId = findString(opened, "tab_id", "tabId", "active_tab_id", "activeTabId");
  if (!worktreePath || !workspaceId) {
    throw new Error("Herdr worktree operation omitted checkout path or workspace ID.");
  }
  if (!rootPaneId) {
    const snapshot = unwrap(
      JSON.parse(
        await runner("herdr", ["workspace", "get", workspaceId], {
          cwd: state.sourceRepositoryPath,
        }),
      ),
    );
    initialTabId ??= findString(snapshot, "active_tab_id", "activeTabId", "tab_id", "tabId");
    rootPaneId = findString(snapshot, "root_pane_id", "rootPaneId");
    if (!rootPaneId) {
      const activeTabId = findString(snapshot, "active_tab_id", "activeTabId");
      const panes = unwrap(
        JSON.parse(
          await runner("herdr", ["pane", "list"], {
            cwd: state.sourceRepositoryPath,
          }),
        ),
      );
      const candidates = uniqueBy(
        findRecords(panes).filter(
          (record) =>
            readString(record, "workspace_id", "workspaceId") === workspaceId &&
            (!activeTabId || readString(record, "tab_id", "tabId") === activeTabId) &&
            readString(record, "pane_id", "paneId", "id"),
        ),
        (record) => readString(record, "pane_id", "paneId", "id"),
      );
      if (candidates.length !== 1) {
        throw new Error("Herdr worktree workspace must have exactly one pane in its active tab.");
      }
      rootPaneId = readString(candidates[0]!, "pane_id", "paneId", "id");
      initialTabId ??= readString(candidates[0]!, "tab_id", "tabId");
    }
  }
  if (!rootPaneId) throw new Error("Herdr worktree workspace has no root pane.");
  if (!initialTabId) {
    const rootPane = unwrap(
      JSON.parse(
        await runner("herdr", ["pane", "get", rootPaneId], {
          cwd: state.sourceRepositoryPath,
        }),
      ),
    );
    initialTabId = findString(rootPane, "tab_id", "tabId");
  }
  if (!initialTabId) throw new Error("Herdr worktree workspace has no initial tab.");
  await runner("herdr", ["tab", "rename", initialTabId, state.tabLabel ?? "submind"], {
    cwd: state.sourceRepositoryPath,
  });
  const canonicalWorktree = await realpath(worktreePath);
  const commonSource = await gitCommonDirectory(state.sourceRepositoryPath, runner);
  const commonWorktree = await gitCommonDirectory(canonicalWorktree, runner);
  if (commonSource !== commonWorktree) {
    throw new Error("Herdr returned a worktree outside the intended repository.");
  }
  return { worktreePath: canonicalWorktree, workspaceId, rootPaneId };
}

async function gitCommonDirectory(cwd: string, runner: CommandRunner): Promise<string> {
  const path = (
    await runner("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
  ).trim();
  return realpath(path);
}

function unwrap(value: unknown): unknown {
  const parsed = z.unknown().parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  return record.result ?? record.data ?? parsed;
}

function findRecords(value: unknown): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  visit(value, (record) => output.push(record));
  return output;
}

function visit(value: unknown, operation: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, operation);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  operation(record);
  for (const child of Object.values(record)) visit(child, operation);
}

function hasRepositoryPath(record: Record<string, unknown>): boolean {
  return repositoryPath(record) !== undefined || checkoutPath(record) !== undefined;
}

function repositoryPath(record: Record<string, unknown>): string | undefined {
  const worktree = asRecord(record.worktree);
  return (
    readString(record, "repo_root", "repoRoot") ?? readString(worktree, "repo_root", "repoRoot")
  );
}

function checkoutPath(record: Record<string, unknown>): string | undefined {
  const worktree = asRecord(record.worktree);
  return (
    readString(record, "checkout_path", "checkoutPath") ??
    readString(worktree, "checkout_path", "checkoutPath")
  );
}

function findString(value: unknown, ...keys: string[]): string | undefined {
  let found: string | undefined;
  visit(value, (record) => {
    found ??= readString(record, ...keys);
  });
  return found;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueBy<T>(values: T[], key: (value: T) => string | undefined): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function canonicalIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
  return result.stdout;
}
