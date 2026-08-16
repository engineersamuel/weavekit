import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRepositoryMode, type ProjectCatalogEntry } from "../../src/config.js";
import {
  HerdrWorkspaceProvisioner,
  type WorkspaceProvisionRequest,
  type WorkspaceShell,
} from "../../src/submind/index.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Herdr execution workspace provisioner", () => {
  it("creates a missing greenfield provisioning root before resolving it", async () => {
    const root = join(await tempDirectory(), "prototypes");
    const provisioner = new HerdrWorkspaceProvisioner();

    const descriptor = await provisioner.describe(request(greenfieldProject(root)));

    expect((await stat(root)).isDirectory()).toBe(true);
    expect(descriptor).toMatchObject({
      kind: "greenfield-repository-worktree",
      provisioningRoot: await realpath(root),
    });
  });

  it("matches the parent by canonical repository path and creates one dedicated worktree", async () => {
    const source = await createRepository();
    const worktree = join(await tempDirectory(), "execution-worktree");
    const shell = fakeHerdrShell(source, worktree, {
      workspaces: [
        {
          workspace_id: "wrong",
          label: "Existing",
          worktree: { repo_root: join(source, "not-the-repository") },
        },
        {
          workspace_id: "parent",
          label: "Unrelated label",
          worktree: { repo_root: source },
        },
      ],
      omitRootPane: true,
    });
    const provisioner = new HerdrWorkspaceProvisioner(shell);
    const descriptor = await provisioner.describe(request(existingProject(source)));

    const provisioned = await provisioner.provision(descriptor, existingProject(source));

    expect(provisioned).toMatchObject({
      kind: "existing-repository-worktree",
      sourceRepositoryPath: await realpath(source),
      checkoutPath: await realpath(worktree),
      branchName: "mastermind/wk-1-work-one",
      lastObservedWorkspaceId: "execution",
      lastObservedRootPaneId: "execution:p1",
    });
    expect(shell.calls.filter((call) => call.args[1] === "create")).toEqual([
      expect.objectContaining({
        args: expect.arrayContaining(["--workspace", "parent"]),
      }),
    ]);
    expect(
      shell.calls.some((call) => call.args[0] === "workspace" && call.args[1] === "create"),
    ).toBe(false);
  });

  it("adopts the same deterministic worktree on retry and ignores stale persisted IDs", async () => {
    const source = await createRepository();
    const worktree = join(await tempDirectory(), "execution-worktree");
    const shell = fakeHerdrShell(source, worktree, {
      workspaces: [
        {
          workspace_id: "parent-current",
          worktree: { repo_root: source },
        },
      ],
    });
    const provisioner = new HerdrWorkspaceProvisioner(shell);
    const descriptor = {
      ...(await provisioner.describe(request(existingProject(source)))),
      lastObservedWorkspaceId: "stale-workspace",
      lastObservedTabId: "stale-tab",
      lastObservedRootPaneId: "stale-pane",
    };
    const first = await provisioner.provision(descriptor, existingProject(source));
    const second = await provisioner.provision(
      { ...first, creatorAttemptId: "attempt-two" },
      existingProject(source),
    );

    expect(second.checkoutPath).toBe(first.checkoutPath);
    expect(second.lastObservedWorkspaceId).toBe("execution");
    expect(shell.calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
    expect(shell.calls.filter((call) => call.args[1] === "open")).toHaveLength(1);
  });

  it("creates a contained greenfield repository with only provenance and a seed commit", async () => {
    const root = await tempDirectory();
    const project = greenfieldProject(root);
    const provisioner = new HerdrWorkspaceProvisioner(
      fakeHerdrShell(undefined, join(await tempDirectory(), "greenfield-worktree")),
    );
    const descriptor = await provisioner.describe(request(project));
    expect(descriptor.kind).toBe("greenfield-repository-worktree");

    const provisioned = await provisioner.provision(descriptor, project);

    if (provisioned.kind !== "greenfield-repository-worktree") {
      throw new Error("Expected greenfield workspace.");
    }
    expect(provisioned.sourceRepositoryPath.startsWith(`${await realpath(root)}/`)).toBe(true);
    expect((await readdir(provisioned.sourceRepositoryPath)).sort()).toEqual([
      ".git",
      ".weavekit-mastermind-workspace.json",
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(provisioned.sourceRepositoryPath, ".weavekit-mastermind-workspace.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      workId: "work-one",
      creatorAttemptId: "attempt-one",
      projectId: "prototype",
    });
    expect(
      (
        await execFileAsync("git", ["show", "--format=", "--name-only", "HEAD"], {
          cwd: provisioned.sourceRepositoryPath,
        })
      ).stdout.trim(),
    ).toBe(".weavekit-mastermind-workspace.json");
  });

  it("fails closed on a symlink escape or mismatched greenfield marker", async () => {
    const root = await tempDirectory();
    const outside = await tempDirectory();
    const project = greenfieldProject(root);
    const provisioner = new HerdrWorkspaceProvisioner(
      fakeHerdrShell(undefined, join(await tempDirectory(), "worktree")),
    );
    const descriptor = await provisioner.describe(request(project));
    if (descriptor.kind !== "greenfield-repository-worktree") {
      throw new Error("Expected greenfield workspace.");
    }
    await symlink(outside, descriptor.sourceRepositoryPath);

    await expect(provisioner.provision(descriptor, project)).rejects.toThrow("contained child");

    await rm(descriptor.sourceRepositoryPath);
    await execFileAsync("mkdir", ["-p", descriptor.sourceRepositoryPath]);
    await writeFile(
      join(descriptor.sourceRepositoryPath, ".weavekit-mastermind-workspace.json"),
      JSON.stringify({
        schemaVersion: 1,
        workId: "different-work",
        projectId: project.id,
        creatorAttemptId: "attempt-one",
      }),
    );
    await expect(provisioner.provision(descriptor, project)).rejects.toThrow(
      "collision requires human review",
    );
  });
});

function fakeHerdrShell(
  sourcePath: string | undefined,
  worktreePath: string,
  options: {
    workspaces?: Array<Record<string, unknown>>;
    omitRootPane?: boolean;
  } = {},
): WorkspaceShell & { calls: Array<{ command: string; args: string[]; cwd: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  let parentCreated = false;
  let worktreeCreated = false;
  const shell = {
    calls,
    async run(command: string, args: string[], runOptions: { cwd: string }): Promise<string> {
      calls.push({ command, args, cwd: runOptions.cwd });
      if (command === "git") {
        return (
          await execFileAsync(command, args, {
            cwd: runOptions.cwd,
            encoding: "utf8",
          })
        ).stdout;
      }
      if (args[0] === "workspace" && args[1] === "list") {
        const repository = sourcePath ?? runOptions.cwd;
        return envelope({
          workspaces:
            options.workspaces ??
            (parentCreated
              ? [{ workspace_id: "parent-created", worktree: { repo_root: repository } }]
              : []),
        });
      }
      if (args[0] === "workspace" && args[1] === "create") {
        parentCreated = true;
        return envelope({ workspace: { workspace_id: "parent-created" } });
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return envelope({
          worktrees: worktreeCreated
            ? [
                {
                  branch: "mastermind/wk-1-work-one",
                  path: worktreePath,
                  open_workspace_id: "execution",
                },
              ]
            : [],
        });
      }
      if (args[0] === "worktree" && args[1] === "create") {
        await execFileAsync(
          "git",
          [
            "worktree",
            "add",
            "-b",
            valueAfter(args, "--branch"),
            worktreePath,
            valueAfter(args, "--base"),
          ],
          { cwd: runOptions.cwd },
        );
        worktreeCreated = true;
        return envelope({
          worktree: { path: worktreePath },
          workspace_id: "execution",
          tab: { tab_id: "execution:t1" },
          ...(options.omitRootPane ? {} : { root_pane: { pane_id: "execution:p1" } }),
        });
      }
      if (args[0] === "worktree" && args[1] === "open") {
        return envelope({
          worktree: { path: worktreePath },
          workspace_id: "execution",
          root_pane: { pane_id: "execution:p1" },
        });
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return envelope({
          workspace: {
            workspace_id: "execution",
            active_tab_id: "execution:t1",
          },
        });
      }
      if (args[0] === "pane" && args[1] === "list") {
        return envelope({
          panes: [
            {
              pane_id: "execution:p1",
              tab_id: "execution:t1",
              workspace_id: "execution",
              cwd: worktreePath,
            },
          ],
        });
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  return shell;
}

async function createRepository(): Promise<string> {
  const directory = await tempDirectory();
  await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: directory });
  await writeFile(join(directory, "README.md"), "# Test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: directory },
  );
  return directory;
}

function request(project: ProjectCatalogEntry): WorkspaceProvisionRequest {
  return {
    workId: "work-one",
    workCreatedAt: "2026-08-06T12:00:00.000Z",
    attemptId: "attempt-one",
    ticket: {
      id: "issue-one",
      identifier: "WK-1",
      url: "https://linear.app/example/issue/WK-1",
      title: "Build a safe prototype",
      description: "Prototype it.",
      labels: [],
      status: "Todo",
      teamId: "team-one",
    },
    project,
  };
}

function existingProject(workingTree: string): ProjectCatalogEntry {
  return {
    id: "weavekit",
    displayName: "Weavekit",
    workingTree,
    repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
    mainline: "origin main",
    remote: "origin",
    contextDocs: [],
    validationCommands: [],
    autonomousPrAllowed: false,
    notification: "cli",
    knowledgeExport: "off",
  };
}

function greenfieldProject(provisioningRoot: string): ProjectCatalogEntry {
  return {
    ...existingProject(""),
    id: "prototype",
    displayName: "Prototype",
    repositoryMode: ProjectRepositoryMode.GREENFIELD,
    provisioningRoot,
  };
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

function envelope(result: Record<string, unknown>): string {
  return JSON.stringify({ id: "test", result });
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-workspace-"));
  directories.push(directory);
  return directory;
}
