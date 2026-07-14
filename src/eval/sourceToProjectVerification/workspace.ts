import { createHash } from "node:crypto";
import { cp, copyFile, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ProjectVerificationWorkspaceSource = {
  projectDir: string;
  sourcePath: string;
};

export type ProjectVerificationWorkspace = {
  rootDir: string;
  projectDir: string;
  sourcePath: string;
};

export class ProjectVerificationWorkspaceMutationError<T = unknown> extends Error {
  readonly result: T;
  readonly changedFiles: string[];

  constructor(result: T, changedFiles: string[], detail?: string) {
    const detailSuffix = detail ? `. ${detail}` : "";
    super(
      `Provider modified the controlled target project: ${changedFiles.join(", ")}${detailSuffix}`,
    );
    this.name = "ProjectVerificationWorkspaceMutationError";
    this.result = result;
    this.changedFiles = changedFiles;
  }
}

export async function withProjectVerificationWorkspace<T>(
  source: ProjectVerificationWorkspaceSource,
  run: (workspace: ProjectVerificationWorkspace) => Promise<T>,
): Promise<T> {
  await validateProjectSymlinks(source.projectDir);
  const rootDir = await mkdtemp(join(tmpdir(), "weavekit-project-verification-"));
  const projectDir = join(rootDir, "project");
  const sourcePath = join(rootDir, "source.md");
  try {
    await cp(source.projectDir, projectDir, { recursive: true, verbatimSymlinks: true });
    await copyFile(source.sourcePath, sourcePath);
    const before = await snapshotDirectory(projectDir);
    const result = await run({ rootDir, projectDir, sourcePath });
    const after = await snapshotAfterProvider(projectDir, result);
    const changedFiles = compareSnapshots(before, after);
    if (changedFiles.length > 0) {
      throw new ProjectVerificationWorkspaceMutationError(result, changedFiles);
    }
    return result;
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function snapshotDirectory(rootDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  await visitDirectory(rootDir, rootDir, snapshot);
  return snapshot;
}

async function visitDirectory(
  rootDir: string,
  currentDir: string,
  snapshot: Map<string, string>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      snapshot.set(relative(rootDir, path), `symlink:${await readlink(path)}`);
      continue;
    }
    if (entry.isDirectory()) {
      await visitDirectory(rootDir, path, snapshot);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    snapshot.set(relative(rootDir, path), hash);
  }
}

async function validateProjectSymlinks(projectDir: string): Promise<void> {
  const projectRoot = resolve(projectDir);
  await visitProjectSymlinks(projectRoot, projectRoot);
}

async function visitProjectSymlinks(projectRoot: string, currentDir: string): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await visitProjectSymlinks(projectRoot, path);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const target = await readlink(path);
    const resolvedTarget = resolve(dirname(path), target);
    if (isAbsolute(target) || isOutsideProject(projectRoot, resolvedTarget)) {
      throw new Error(
        `Unsafe source-project symlink ${relative(projectRoot, path)} points outside the project: ${target}`,
      );
    }
  }
}

function isOutsideProject(projectRoot: string, candidate: string): boolean {
  const relativePath = relative(projectRoot, candidate);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

async function snapshotAfterProvider<T>(
  projectDir: string,
  result: T,
): Promise<Map<string, string>> {
  try {
    return await snapshotDirectory(projectDir);
  } catch (error) {
    throw new ProjectVerificationWorkspaceMutationError(
      result,
      ["<project-root>"],
      `Post-run verification could not snapshot the project root: ${errorMessage(error)}`,
    );
  }
}

function compareSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
