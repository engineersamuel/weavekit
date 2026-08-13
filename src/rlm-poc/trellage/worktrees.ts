import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mainRepository,
  provisionHerdrWorktree,
  type ExistingHerdrWorktree,
} from "../../herdr/provision.js";

const execFileAsync = promisify(execFile);

export type TrellageWorktree = ExistingHerdrWorktree & {
  rootPaneId?: string;
  /** Path of the repository's main working tree, which this worktree was cut from. */
  repositoryPath: string;
  branchName: string;
  /** Commit the branch started at, used to detect whether the delegated work produced anything. */
  baseSha: string;
  /** True when the checkout predated this run and must never be reclaimed by it. */
  reused?: boolean;
};

export type TrellageWorktreeDisposition = {
  worktree: TrellageWorktree;
  /** True when the tree is dirty or the branch has moved past `baseSha`. */
  changed: boolean;
  /** One-line summary of what changed, for the run receipt. */
  summary: string;
  removed: boolean;
  removalError?: string;
};

export type TrellageWorktreeRegistryOptions = {
  runId: string;
  provision?: typeof provisionHerdrWorktree;
  canonicalize?: typeof mainRepository;
  run?: (command: string, args: string[], cwd: string) => Promise<string>;
  currentWorktree?: ExistingHerdrWorktree;
};

/**
 * Owns the Herdr worktrees delegated harnesses run inside — one per repository.
 *
 * Mutating work must never land in the user's own checkout, and concurrent harnesses must never
 * share a tree: recursive `rlm` sessions can each call `invoke_trellage`, and two agents editing
 * one checkout would silently corrupt each other. So each repository gets a dedicated worktree and
 * a mutex that serializes mutating invocations against it.
 */
export class TrellageWorktreeRegistry {
  private readonly worktrees = new Map<string, Promise<TrellageWorktree>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly options: Required<
    Pick<TrellageWorktreeRegistryOptions, "runId" | "provision" | "canonicalize" | "run">
  >;
  private readonly currentWorktree?: ExistingHerdrWorktree;

  constructor(options: TrellageWorktreeRegistryOptions) {
    this.options = {
      runId: options.runId,
      provision: options.provision ?? provisionHerdrWorktree,
      canonicalize: options.canonicalize ?? mainRepository,
      run: options.run ?? defaultRun,
    };
    this.currentWorktree = options.currentWorktree;
  }

  /**
   * Returns the worktree for `repositoryPath`, provisioning it on first use.
   *
   * The promise is cached rather than the value so concurrent callers share one provisioning
   * attempt instead of racing to create duplicate worktrees for the same repository.
   */
  async acquire(repositoryPath: string): Promise<TrellageWorktree> {
    const repository = await this.options.canonicalize(repositoryPath);
    const existing = this.worktrees.get(repository);
    if (existing) return existing;
    const pending = this.provisionFor(repository).catch((error: unknown) => {
      // A failed provision must not poison the cache; a later call should be free to retry.
      this.worktrees.delete(repository);
      throw error;
    });
    this.worktrees.set(repository, pending);
    return pending;
  }

  /** Runs `operation` with exclusive access to the repository's worktree. */
  async withExclusiveAccess<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
    const repository = await this.options.canonicalize(repositoryPath);
    const previous = this.locks.get(repository) ?? Promise.resolve();
    // Swallow the predecessor's failure: waiters queue on completion, not on success.
    const pending = previous.then(operation, operation);
    this.locks.set(
      repository,
      pending.catch(() => undefined),
    );
    return pending;
  }

  list(): Promise<TrellageWorktree[]> {
    return Promise.all(this.worktrees.values());
  }

  /**
   * Reports what each worktree produced and reclaims the ones nothing touched.
   *
   * A worktree that holds changes is always kept: reclaiming it would destroy delegated work that
   * the user has not seen yet.
   */
  async finalize(): Promise<TrellageWorktreeDisposition[]> {
    const dispositions: TrellageWorktreeDisposition[] = [];
    for (const pending of this.worktrees.values()) {
      let worktree: TrellageWorktree;
      try {
        worktree = await pending;
      } catch {
        continue;
      }
      const { changed, summary } = await this.inspect(worktree);
      if (changed || worktree.reused) {
        dispositions.push({ worktree, changed, summary, removed: false });
        continue;
      }
      try {
        await this.options.run(
          "herdr",
          ["worktree", "remove", "--workspace", worktree.workspaceId],
          worktree.repositoryPath,
        );
        await this.deleteBranch(worktree);
        dispositions.push({ worktree, changed, summary, removed: true });
      } catch (error) {
        dispositions.push({
          worktree,
          changed,
          summary,
          removed: false,
          removalError: String(error),
        });
      }
    }
    this.worktrees.clear();
    return dispositions;
  }

  /**
   * Drops the run branch once its worktree is gone.
   *
   * `herdr worktree remove` deletes the checkout but leaves the branch, so without this every run
   * would leave an `rlm/<runId>` ref behind forever. Only reclaimed worktrees reach here, and they
   * are reclaimed precisely because they hold no commits and no changes, so nothing can be lost.
   * A failure is deliberately swallowed: a leftover branch is untidy, not harmful, and must not
   * turn a successful run into an error.
   */
  private async deleteBranch(worktree: TrellageWorktree): Promise<void> {
    try {
      await this.options.run(
        "git",
        ["branch", "--delete", "--force", worktree.branchName],
        worktree.repositoryPath,
      );
    } catch {
      // Intentionally ignored; the worktree itself is already gone.
    }
  }

  private async provisionFor(repository: string): Promise<TrellageWorktree> {
    if (this.currentWorktree) {
      const [baseSha, branchName] = await Promise.all([
        this.options.run("git", ["rev-parse", "HEAD"], this.currentWorktree.worktreePath),
        this.options.run("git", ["branch", "--show-current"], this.currentWorktree.worktreePath),
      ]);
      const branch = branchName.trim();
      if (!branch) throw new Error("Current-worktree reuse requires a checked-out branch.");
      return {
        ...this.currentWorktree,
        repositoryPath: repository,
        branchName: branch,
        baseSha: baseSha.trim(),
        reused: true,
      };
    }
    const branchName = `rlm/${this.options.runId}`;
    const provisioned = await this.options.provision({
      sourceRepositoryPath: repository,
      branchName,
      runId: this.options.runId,
      workspaceLabel: `RLM ${this.options.runId}`,
      tabLabel: "rlm",
    });
    const baseSha = (
      await this.options.run("git", ["rev-parse", "HEAD"], provisioned.worktreePath)
    ).trim();
    return { ...provisioned, repositoryPath: repository, branchName, baseSha };
  }

  private async inspect(
    worktree: TrellageWorktree,
  ): Promise<{ changed: boolean; summary: string }> {
    try {
      const status = (
        await this.options.run("git", ["status", "--porcelain"], worktree.worktreePath)
      ).trim();
      const commits = (
        await this.options.run(
          "git",
          ["rev-list", "--count", `${worktree.baseSha}..HEAD`],
          worktree.worktreePath,
        )
      ).trim();
      const commitCount = Number.parseInt(commits, 10) || 0;
      const changedFiles = status.length > 0 ? status.split(/\r?\n/u).length : 0;
      if (changedFiles === 0 && commitCount === 0) {
        return { changed: false, summary: "no changes" };
      }
      return {
        changed: true,
        summary: `${commitCount} commit(s), ${changedFiles} uncommitted file(s)`,
      };
    } catch (error) {
      // If the state cannot be read, assume the worktree holds work rather than deleting it.
      return { changed: true, summary: `state unavailable: ${String(error)}` };
    }
  }
}

async function defaultRun(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, encoding: "utf8" });
  return stdout;
}
