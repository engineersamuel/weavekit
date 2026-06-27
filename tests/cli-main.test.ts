import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const shutdown = vi.fn(async () => {
  throw new Error("telemetry shutdown failed");
});

vi.mock("../src/telemetry/bootstrap.js", () => ({
  startTelemetry: vi.fn(async () => ({ shutdown })),
}));

vi.mock("../src/decision-council/runner.js", () => ({
  runDecisionCouncil: vi.fn(async () => ({
    recommendation: "Use Flue",
  })),
}));

import { main } from "../src/cli.js";

describe("CLI main", () => {
  it("ignores telemetry shutdown failures after a successful run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-cli-main-"));
    const inputPath = join(dir, "question.md");
    await writeFile(inputPath, "# Question\n\nShould we use Flue?", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const argvSnapshot = process.argv;
    process.argv = ["node", "weavekit", "decision-council", "run", "--input", inputPath];

    try {
      await expect(main()).resolves.toBeUndefined();

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Telemetry shutdown failed: telemetry shutdown failed"));
    } finally {
      process.argv = argvSnapshot;
      stderrSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
