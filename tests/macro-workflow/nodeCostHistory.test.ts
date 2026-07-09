import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultNodeCostHistoryPath,
  loadNodeCostHistory,
  recordNodeCostHistoryFromUsage,
} from "../../src/macro-workflow/nodeCostHistory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("node cost history", () => {
  it("defaults to a JSON file under ~/.weavekit", () => {
    expect(defaultNodeCostHistoryPath()).toBe(
      join(homedir(), ".weavekit", "node-cost-history.json"),
    );
  });

  it("writes rolling average token and cost observations per node", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-node-cost-history-"));
    tempDirs.push(dir);
    const path = join(dir, "node-cost-history.json");

    await recordNodeCostHistoryFromUsage({
      path,
      summary: {
        totalTokens: 1200,
        estimatedCostUsd: 0.02,
        unpricedModels: [],
        records: [
          {
            id: "usage-1",
            executor: "copilot-sdk",
            nodeId: "plan-opportunity",
            label: "Plan opportunity",
            model: "gpt-5.5",
            inputTokens: 1000,
            outputTokens: 200,
            totalTokens: 1200,
            estimatedCostUsd: 0.02,
          },
        ],
      },
      now: new Date("2026-07-09T00:00:00.000Z"),
    });
    await recordNodeCostHistoryFromUsage({
      path,
      summary: {
        totalTokens: 2400,
        estimatedCostUsd: 0.04,
        unpricedModels: [],
        records: [
          {
            id: "usage-2",
            executor: "copilot-sdk",
            nodeId: "plan-opportunity",
            label: "Plan opportunity",
            model: "gpt-5.5",
            inputTokens: 2000,
            outputTokens: 400,
            totalTokens: 2400,
            estimatedCostUsd: 0.04,
          },
        ],
      },
      now: new Date("2026-07-09T01:00:00.000Z"),
    });

    const history = await loadNodeCostHistory(path);
    const key = "copilot-sdk:gpt-5.5:plan-opportunity";
    expect(history.nodes[key]).toMatchObject({
      key,
      nodeId: "plan-opportunity",
      harness: "copilot-sdk",
      model: "gpt-5.5",
      samples: 2,
      averageTokens: 1800,
      costSamples: 2,
      averageCostUsd: 0.03,
      updatedAt: "2026-07-09T01:00:00.000Z",
    });

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it("does not create a history file when the usage summary has no node-level records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-node-cost-history-"));
    tempDirs.push(dir);
    const path = join(dir, "node-cost-history.json");

    await recordNodeCostHistoryFromUsage({
      path,
      summary: {
        totalTokens: 1200,
        estimatedCostUsd: 0.02,
        unpricedModels: [],
        records: [
          {
            id: "usage-1",
            executor: "baml",
            operation: "PlanWorkflow",
            label: "BAML PlanWorkflow",
            model: "gpt-5.5",
            inputTokens: 1000,
            outputTokens: 200,
            totalTokens: 1200,
            estimatedCostUsd: 0.02,
          },
        ],
      },
      now: new Date("2026-07-09T00:00:00.000Z"),
    });

    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not dilute priced cost averages with earlier unpriced samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-node-cost-history-"));
    tempDirs.push(dir);
    const path = join(dir, "node-cost-history.json");

    await recordNodeCostHistoryFromUsage({
      path,
      summary: {
        totalTokens: 1200,
        unpricedModels: ["unknown-model"],
        records: [
          {
            id: "usage-1",
            executor: "copilot-sdk",
            nodeId: "plan-opportunity",
            label: "Plan opportunity",
            model: "unknown-model",
            inputTokens: 1000,
            outputTokens: 200,
            totalTokens: 1200,
          },
        ],
      },
      now: new Date("2026-07-09T00:00:00.000Z"),
    });
    await recordNodeCostHistoryFromUsage({
      path,
      summary: {
        totalTokens: 2400,
        estimatedCostUsd: 0.04,
        unpricedModels: [],
        records: [
          {
            id: "usage-2",
            executor: "copilot-sdk",
            nodeId: "plan-opportunity",
            label: "Plan opportunity",
            model: "unknown-model",
            inputTokens: 2000,
            outputTokens: 400,
            totalTokens: 2400,
            estimatedCostUsd: 0.04,
          },
        ],
      },
      now: new Date("2026-07-09T01:00:00.000Z"),
    });

    const history = await loadNodeCostHistory(path);
    const entry = history.nodes["copilot-sdk:unknown-model:plan-opportunity"];
    expect(entry).toMatchObject({
      samples: 2,
      averageTokens: 1800,
      costSamples: 1,
      averageCostUsd: 0.04,
    });
  });
});
