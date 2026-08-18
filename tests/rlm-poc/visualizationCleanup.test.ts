import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RLM_VISUALIZATION_DIRECTORY,
  RLM_VISUALIZATION_HTML_PATH,
  RLM_VISUALIZATION_PNG_PATH,
  RLM_VISUALIZATION_STATE_PATH,
  clearRlmVisualizationArtifacts,
} from "../../src/rlm-poc/visualization/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workingDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rlm-visualization-cleanup-"));
  directories.push(path);
  return path;
}

async function writeStaleRun(path: string): Promise<void> {
  await mkdir(join(path, RLM_VISUALIZATION_DIRECTORY), { recursive: true });
  await Promise.all(
    [RLM_VISUALIZATION_HTML_PATH, RLM_VISUALIZATION_PNG_PATH, RLM_VISUALIZATION_STATE_PATH].map(
      (artifact) => writeFile(join(path, artifact), "previous run"),
    ),
  );
}

describe("clearRlmVisualizationArtifacts", () => {
  it("removes the previous run's HTML, PNG, state, and their directory", async () => {
    const path = await workingDirectory();
    await writeStaleRun(path);

    await clearRlmVisualizationArtifacts(path);

    await expect(readdir(join(path, RLM_VISUALIZATION_DIRECTORY))).rejects.toThrow();
  });

  it("keeps every other .weavekit file of the same run", async () => {
    const path = await workingDirectory();
    await writeStaleRun(path);
    await writeFile(join(path, ".weavekit", "mastermind-rlm-prompt.txt"), "prompt");

    await clearRlmVisualizationArtifacts(path);

    expect(await readdir(join(path, ".weavekit"))).toEqual(["mastermind-rlm-prompt.txt"]);
  });

  it("succeeds when no previous run left anything behind", async () => {
    const path = await workingDirectory();

    await expect(clearRlmVisualizationArtifacts(path)).resolves.toBeUndefined();
  });
});
