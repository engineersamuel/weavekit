import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ProjectRepositoryMode, type ProjectCatalogEntry } from "../config.js";
import type { LinearTicketSnapshot } from "../mastermind/store/store.js";
import type { ExecutionWorkspace } from "./contracts.js";
import { findHerdrString, findWorkspaceRootPaneId, parseHerdrEnvelope } from "./herdrJson.js";

const execFileAsync = promisify(execFile);
const markerName = ".weavekit-mastermind-workspace.json";

export type WorkspaceShell = {
  run(command: string, args: string[], options: { cwd: string }): Promise<string>;
};

export type WorkspaceProvisionRequest = {
  workId: string;
  workCreatedAt: string;
  attemptId: string;
  ticket: LinearTicketSnapshot;
  project: ProjectCatalogEntry;
};

export type WorkspaceProvisioner = {
  describe(request: WorkspaceProvisionRequest): Promise<ExecutionWorkspace>;
  provision(
    workspace: ExecutionWorkspace,
    project: ProjectCatalogEntry,
  ): Promise<ExecutionWorkspace>;
};

export class HerdrWorkspaceProvisioner implements WorkspaceProvisioner {
  constructor(private readonly shell: WorkspaceShell = { run: runCommand }) {}

  async describe(request: WorkspaceProvisionRequest): Promise<ExecutionWorkspace> {
    const branchName = deterministicBranchName(request.ticket.identifier, request.workId);
    if (
      (request.project.repositoryMode ?? ProjectRepositoryMode.EXISTING_REPOSITORY) ===
      ProjectRepositoryMode.EXISTING_REPOSITORY
    ) {
      const sourceRepositoryPath = await realpath(request.project.workingTree);
      return {
        kind: "existing-repository-worktree",
        sourceRepositoryPath,
        checkoutPath: "",
        branchName,
        parentWorkspaceLookupPath: sourceRepositoryPath,
        creatorAttemptId: request.attemptId,
      };
    }
    if (!request.project.provisioningRoot) {
      throw new Error(`Greenfield project ${request.project.id} has no provisioning root.`);
    }
    const provisioningRoot = await realpath(request.project.provisioningRoot);
    const directoryName = greenfieldDirectoryName(request);
    if (isAbsolute(directoryName)) {
      throw new Error("Greenfield workspace segment must be relative.");
    }
    const sourceRepositoryPath = resolve(provisioningRoot, directoryName);
    assertContainedChild(provisioningRoot, sourceRepositoryPath);
    return {
      kind: "greenfield-repository-worktree",
      provisioningRoot,
      workId: request.workId,
      sourceRepositoryPath,
      checkoutPath: "",
      branchName,
      parentWorkspaceLookupPath: sourceRepositoryPath,
      creatorAttemptId: request.attemptId,
    };
  }

  async provision(
    workspace: ExecutionWorkspace,
    project: ProjectCatalogEntry,
  ): Promise<ExecutionWorkspace> {
    if (workspace.kind === "greenfield-repository-worktree") {
      await this.ensureGreenfieldRepository(workspace, project);
    }
    const sourceRepositoryPath = await realpath(workspace.sourceRepositoryPath);
    const parentWorkspaceId = await this.ensureParentWorkspace(
      sourceRepositoryPath,
      project.displayName,
    );
    const worktree = await this.ensureWorktree({
      sourceRepositoryPath,
      parentWorkspaceId,
      branchName: workspace.branchName,
      baseRef: mainlineRef(project.mainline),
      label: `${project.displayName} ${workspace.branchName}`,
    });
    const checkoutPath = await realpath(worktree.checkoutPath);
    const repositoryRoot = await this.git(sourceRepositoryPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonGitDir = await realpath(resolve(sourceRepositoryPath, repositoryRoot.trim()));
    const checkoutCommonGitDir = await this.git(checkoutPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if ((await realpath(resolve(checkoutPath, checkoutCommonGitDir.trim()))) !== commonGitDir) {
      throw new Error("Herdr returned a worktree outside the intended repository.");
    }
    return {
      ...workspace,
      sourceRepositoryPath,
      checkoutPath,
      lastObservedWorkspaceId: worktree.workspaceId,
      lastObservedTabId: worktree.tabId,
      lastObservedRootPaneId: worktree.rootPaneId,
    };
  }

  private async ensureGreenfieldRepository(
    workspace: Extract<ExecutionWorkspace, { kind: "greenfield-repository-worktree" }>,
    project: ProjectCatalogEntry,
  ): Promise<void> {
    assertContainedChild(workspace.provisioningRoot, workspace.sourceRepositoryPath);
    const exists = await pathExists(workspace.sourceRepositoryPath);
    let markerExists = false;
    if (exists) {
      const canonical = await realpath(workspace.sourceRepositoryPath);
      assertContainedChild(workspace.provisioningRoot, canonical);
      const entries = await import("node:fs/promises").then(({ readdir }) =>
        readdir(workspace.sourceRepositoryPath),
      );
      if (entries.length > 0) {
        const marker = await readMarker(workspace.sourceRepositoryPath);
        if (
          !marker ||
          marker.schemaVersion !== 1 ||
          marker.workId !== markerExpected(workspace).workId ||
          marker.projectId !== project.id
        ) {
          throw new Error("Greenfield workspace collision requires human review.");
        }
        markerExists = true;
      }
    } else {
      await mkdir(workspace.sourceRepositoryPath);
    }
    if (!markerExists) {
      await writeMarker(workspace, project.id);
    }
    if (!(await pathExists(join(workspace.sourceRepositoryPath, ".git")))) {
      await this.git(workspace.sourceRepositoryPath, [
        "init",
        "--initial-branch",
        mainlineRef(project.mainline),
      ]);
      await this.git(workspace.sourceRepositoryPath, [
        "-c",
        "user.name=Weavekit Mastermind",
        "-c",
        "user.email=mastermind@localhost",
        "add",
        markerName,
      ]);
      await this.git(workspace.sourceRepositoryPath, [
        "-c",
        "user.name=Weavekit Mastermind",
        "-c",
        "user.email=mastermind@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "chore: initialize mastermind workspace",
      ]);
    }
  }

  private async ensureParentWorkspace(sourcePath: string, label: string): Promise<string> {
    const result = parseHerdrEnvelope(
      await this.shell.run("herdr", ["workspace", "list"], { cwd: sourcePath }),
      "herdr workspace list",
    );
    const workspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
    const canonicalSource = await realpath(sourcePath);
    for (const item of workspaces) {
      const record = asRecord(item);
      const worktree = asRecord(record.worktree);
      const candidate =
        typeof worktree.repo_root === "string"
          ? worktree.repo_root
          : typeof worktree.checkout_path === "string"
            ? worktree.checkout_path
            : undefined;
      if (candidate && (await canonicalIfExists(candidate)) === canonicalSource) {
        const workspaceId = stringValue(record.workspace_id);
        if (workspaceId) return workspaceId;
      }
    }
    const created = parseHerdrEnvelope(
      await this.shell.run(
        "herdr",
        ["workspace", "create", "--cwd", sourcePath, "--label", label, "--no-focus"],
        { cwd: sourcePath },
      ),
      "herdr workspace create",
    );
    const workspaceId = findHerdrString(created, "workspace_id", "id");
    if (!workspaceId) {
      throw new Error("Herdr workspace create did not return a workspace ID.");
    }
    return workspaceId;
  }

  private async ensureWorktree(input: {
    sourceRepositoryPath: string;
    parentWorkspaceId: string;
    branchName: string;
    baseRef: string;
    label: string;
  }): Promise<{ checkoutPath: string; workspaceId: string; tabId?: string; rootPaneId: string }> {
    const listed = parseHerdrEnvelope(
      await this.shell.run(
        "herdr",
        ["worktree", "list", "--workspace", input.parentWorkspaceId, "--json"],
        { cwd: input.sourceRepositoryPath },
      ),
      "herdr worktree list",
    );
    const existing = (Array.isArray(listed.worktrees) ? listed.worktrees : []).find((entry) => {
      const record = asRecord(entry);
      return record.branch === input.branchName;
    });
    const args = existing
      ? [
          "worktree",
          "open",
          "--workspace",
          input.parentWorkspaceId,
          "--branch",
          input.branchName,
          "--no-focus",
          "--json",
        ]
      : [
          "worktree",
          "create",
          "--workspace",
          input.parentWorkspaceId,
          "--branch",
          input.branchName,
          "--base",
          input.baseRef,
          "--label",
          input.label,
          "--no-focus",
          "--json",
        ];
    let opened: Record<string, unknown>;
    try {
      opened = parseHerdrEnvelope(
        await this.shell.run("herdr", args, { cwd: input.sourceRepositoryPath }),
        `herdr ${args[1]}`,
      );
    } catch (error) {
      if (!existing && /\b(?:already exists|already checked out)\b/iu.test(String(error))) {
        opened = parseHerdrEnvelope(
          await this.shell.run(
            "herdr",
            [
              "worktree",
              "open",
              "--workspace",
              input.parentWorkspaceId,
              "--branch",
              input.branchName,
              "--no-focus",
              "--json",
            ],
            { cwd: input.sourceRepositoryPath },
          ),
          "herdr worktree open",
        );
      } else {
        throw error;
      }
    }
    const checkoutPath =
      findHerdrString(opened, "checkout_path", "worktree_path", "path") ??
      stringValue(asRecord(existing).path);
    const workspaceId = findHerdrString(opened, "workspace_id", "open_workspace_id");
    if (!checkoutPath || !workspaceId) {
      throw new Error("Herdr worktree operation omitted checkout path or workspace ID.");
    }
    const tabId = findHerdrString(opened, "tab_id");
    let rootPaneId = findHerdrString(opened, "root_pane_id", "pane_id");
    if (!rootPaneId) {
      const workspace = parseHerdrEnvelope(
        await this.shell.run("herdr", ["workspace", "get", workspaceId], {
          cwd: input.sourceRepositoryPath,
        }),
        "herdr workspace get",
      );
      const activeTabId = findHerdrString(workspace, "active_tab_id", "tab_id");
      rootPaneId = findHerdrString(workspace, "root_pane_id", "pane_id");
      if (!rootPaneId) {
        const panes = parseHerdrEnvelope(
          await this.shell.run("herdr", ["pane", "list"], {
            cwd: input.sourceRepositoryPath,
          }),
          "herdr pane list",
        );
        rootPaneId = findWorkspaceRootPaneId(panes, workspaceId, activeTabId);
      }
    }
    if (!rootPaneId) {
      throw new Error("Herdr worktree workspace did not expose a root pane.");
    }
    return { checkoutPath, workspaceId, tabId, rootPaneId };
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return this.shell.run("git", args, { cwd });
  }
}

function deterministicBranchName(identifier: string, workId: string): string {
  const issue = sanitizeSegment(identifier, 24) || "issue";
  const suffix = sanitizeSegment(workId, 8) || "work";
  return `mastermind/${issue}-${suffix}`;
}

function greenfieldDirectoryName(request: WorkspaceProvisionRequest): string {
  const date = request.workCreatedAt.slice(0, 10);
  const issue = sanitizeSegment(request.ticket.identifier, 20) || "issue";
  const title = sanitizeSegment(request.ticket.title, 48) || "project";
  const suffix = sanitizeSegment(request.workId, 8) || "work";
  return `${date}-${issue}-${title}-${suffix}`;
}

function sanitizeSegment(value: string, maxLength: number): string {
  return value
    .normalize("NFKD")
    .split("")
    .filter((character) => character.charCodeAt(0) <= 0x7f)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maxLength)
    .replace(/-+$/gu, "");
}

function mainlineRef(mainline: string): string {
  return mainline.trim().split(/\s+/u).at(-1) || "main";
}

function assertContainedChild(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path === "." || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Execution workspace must be a contained child of the provisioning root.");
  }
}

function markerExpected(
  workspace: Extract<ExecutionWorkspace, { kind: "greenfield-repository-worktree" }>,
): { schemaVersion: 1; workId: string; creatorAttemptId: string } {
  return {
    schemaVersion: 1,
    workId: workspace.workId,
    creatorAttemptId: workspace.creatorAttemptId,
  };
}

async function writeMarker(
  workspace: Extract<ExecutionWorkspace, { kind: "greenfield-repository-worktree" }>,
  projectId: string,
): Promise<void> {
  const expected = markerExpected(workspace);
  const path = join(workspace.sourceRepositoryPath, markerName);
  if (await pathExists(path)) {
    return;
  }
  const temporary = join(dirname(path), `.${markerName}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ ...expected, projectId }, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporary, path).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

async function readMarker(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(path, markerName), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
  return result.stdout;
}
