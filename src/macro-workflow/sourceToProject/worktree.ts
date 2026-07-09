import { execFile } from "node:child_process";
import { copyFile, glob } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorktreePreparationArgs = {
  sourceWorkingTree: string;
  worktreeRoot: string;
  branchName: string;
  mainline?: string;
};

export type WorktreePreparationResult = {
  worktreePath: string;
  branchName: string;
  baselineCommit: string;
  copiedEnvFiles: string[];
};

export type WorktreePreparationDeps = {
  run?: (command: string, args: string[], options: { cwd: string }) => Promise<string>;
  globEnvFiles?: (sourceWorkingTree: string) => Promise<string[]>;
  copyFile?: (source: string, target: string) => Promise<void>;
};

export async function prepareAutonomousWorktree(
  args: WorktreePreparationArgs,
  deps: WorktreePreparationDeps = {},
): Promise<WorktreePreparationResult> {
  const mainline = args.mainline ?? "origin main";
  const [remote, branch] = mainline.split(/\s+/, 2);
  if (!remote || !branch) {
    throw new Error(`Invalid mainline "${mainline}". Expected "<remote> <branch>".`);
  }

  const run = deps.run ?? defaultRun;
  const copy = deps.copyFile ?? copyFile;
  const globEnvFiles = deps.globEnvFiles ?? defaultGlobEnvFiles;
  const worktreePath = join(args.worktreeRoot, args.branchName.replace(/[^a-zA-Z0-9._-]+/g, "-"));

  await run("git", ["worktree", "add", "-B", args.branchName, worktreePath, branch], {
    cwd: args.sourceWorkingTree,
  });
  await run("git", ["pull", "--rebase", remote, branch], { cwd: worktreePath });

  const envFiles = await globEnvFiles(args.sourceWorkingTree);
  if (envFiles.length === 0) {
    throw new Error("No .env* files found to copy into autonomous worktree.");
  }

  for (const envFile of envFiles) {
    await copy(envFile, join(worktreePath, basename(envFile)));
  }

  const baselineCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).trim();

  return {
    worktreePath,
    branchName: args.branchName,
    baselineCommit,
    copiedEnvFiles: envFiles.map((file) => basename(file)),
  };
}

async function defaultRun(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd });
  return result.stdout;
}

async function defaultGlobEnvFiles(sourceWorkingTree: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob(".env*", { cwd: sourceWorkingTree })) {
    files.push(join(sourceWorkingTree, file));
  }
  return files;
}
