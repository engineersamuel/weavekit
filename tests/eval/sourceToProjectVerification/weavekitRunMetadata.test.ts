import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWeavekitRunMetadata } from "../../../src/eval/sourceToProjectVerification/weavekitRunMetadata.js";

describe("loadWeavekitRunMetadata", () => {
  it("loads passed workflow state and normalizes its usage for Promptfoo", async () => {
    const runDir = await writeRunState({
      runId: " run-passed ",
      status: "passed",
      nodeResults: [],
      usage: {
        inputTokens: 800,
        outputTokens: 150,
        cachedInputTokens: 25,
        totalTokens: 950,
        estimatedCostUsd: 0.31,
      },
    });

    await expect(loadWeavekitRunMetadata(runDir)).resolves.toEqual({
      runId: "run-passed",
      status: "passed",
      tokenUsage: { prompt: 800, completion: 150, cached: 25, total: 950 },
      estimatedCostUsd: 0.31,
    });
  });

  it("preserves the failed workflow's failure and usage metadata", async () => {
    const runDir = await writeRunState({
      runId: "run-failed",
      status: "failed",
      nodeResults: [
        {
          nodeId: "audit-portfolio",
          status: "failed",
          output: "",
          error: "Portfolio coverage remains incomplete",
        },
      ],
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 0,
        totalTokens: 1200,
        estimatedCostUsd: 0.42,
      },
    });

    await expect(loadWeavekitRunMetadata(runDir)).resolves.toEqual({
      runId: "run-failed",
      status: "failed",
      failure: "Portfolio coverage remains incomplete",
      tokenUsage: { prompt: 1000, completion: 200, cached: 0, total: 1200 },
      estimatedCostUsd: 0.42,
    });
  });

  it.each([
    ["missing run id", { status: "passed", nodeResults: [] }],
    ["unfinished status", { runId: "run-1", status: "running", nodeResults: [] }],
    ["failed state without failure detail", { runId: "run-1", status: "failed", nodeResults: [] }],
    [
      "invalid usage",
      {
        runId: "run-1",
        status: "passed",
        nodeResults: [],
        usage: { inputTokens: -1 },
      },
    ],
  ])("fails closed for %s", async (_label, state) => {
    const runDir = await writeRunState(state);

    await expect(loadWeavekitRunMetadata(runDir)).rejects.toThrow(/workflow-state\.json/i);
  });

  it("fails closed when workflow-state.json is missing or malformed", async () => {
    const missingRunDir = await mkdtemp(join(tmpdir(), "weavekit-run-metadata-missing-"));
    const malformedRunDir = await mkdtemp(join(tmpdir(), "weavekit-run-metadata-malformed-"));
    await writeFile(join(malformedRunDir, "workflow-state.json"), "{not json", "utf8");

    await expect(loadWeavekitRunMetadata(missingRunDir)).rejects.toThrow(/workflow-state\.json/i);
    await expect(loadWeavekitRunMetadata(malformedRunDir)).rejects.toThrow(/workflow-state\.json/i);
  });
});

async function writeRunState(state: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "weavekit-run-metadata-"));
  const runDir = join(root, "run-dir");
  await mkdir(runDir);
  await writeFile(join(runDir, "workflow-state.json"), JSON.stringify(state), "utf8");
  return runDir;
}
