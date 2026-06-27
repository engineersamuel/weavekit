import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../src/work-queue/decisionCouncilWorkflow.js", () => ({
  createDecisionCouncilBeadsWorkflow: vi.fn(async () => ({
    rootItem: { id: "bd-root" },
    runItem: { id: "bd-run" },
    reviewItem: { id: "bd-review" },
    followUpItem: { id: "bd-follow" },
    items: [
      { id: "bd-root" },
      { id: "bd-run" },
      { id: "bd-review" },
      { id: "bd-follow" },
    ],
  })),
}));

vi.mock("../src/work-queue/telemetry.js", () => ({
  serializeWorkItemWorkflowDag: vi.fn((args) => ({
    rootItemId: args.rootItemId,
    activeItemId: args.activeItemId,
    items: args.items,
  })),
}));

import { main } from "../src/cli.js";
import { runDecisionCouncil } from "../src/decision-council/runner.js";
import { startTelemetry } from "../src/telemetry/bootstrap.js";
import { createDecisionCouncilBeadsWorkflow } from "../src/work-queue/decisionCouncilWorkflow.js";
import { serializeWorkItemWorkflowDag } from "../src/work-queue/telemetry.js";

const startTelemetryMock = vi.mocked(startTelemetry);
const runDecisionCouncilMock = vi.mocked(runDecisionCouncil);
const createDecisionCouncilBeadsWorkflowMock = vi.mocked(createDecisionCouncilBeadsWorkflow);
const serializeWorkItemWorkflowDagMock = vi.mocked(serializeWorkItemWorkflowDag);

describe("CLI main", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("continues running when telemetry startup fails", async () => {
    startTelemetryMock.mockRejectedValueOnce(new Error("invalid Langfuse URL"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const argvSnapshot = process.argv;
    const cwd = await mkdtemp(join(tmpdir(), "weavekit-cli-main-"));
    const inputPath = join(cwd, "question.md");
    await writeFile(inputPath, "# Question\n\nShould we use Flue?", "utf8");
    process.argv = ["node", "weavekit", "decision-council", "run", "--input", inputPath];

    try {
      await expect(main()).resolves.toBeUndefined();

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Telemetry startup failed: invalid Langfuse URL"));
      expect(runDecisionCouncilMock).toHaveBeenCalledTimes(1);
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("Use Flue"));
    } finally {
      process.argv = argvSnapshot;
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("documents telemetry configuration and verification in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("## Telemetry and Observability");
    expect(readme).toContain("### Example: telemetry enabled (OTLP + Langfuse)");
    expect(readme).toContain("OTEL_SDK_DISABLED");
    expect(readme).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(readme).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(readme).toContain("LANGFUSE_PUBLIC_KEY");
    expect(readme).toContain("LANGFUSE_SECRET_KEY");
    expect(readme).toContain("LANGFUSE_BASE_URL");
    expect(readme).toContain("LANGFUSE_EXPORT_RAW");
    expect(readme).toContain('LANGFUSE_PUBLIC_KEY="pk-lf-..."');
    expect(readme).toContain('LANGFUSE_SECRET_KEY="sk-lf-..."');
    expect(readme).toContain('OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318/v1/traces"');
    expect(readme).toContain("### Example: telemetry disabled");
    expect(readme).toContain("OTEL_SDK_DISABLED=true");
    expect(readme).toContain("### Verification");
    expect(readme).toContain("Check for startup/export/shutdown failures in stderr");
    expect(readme).toContain("OTLP");
    expect(readme).toContain("export");
    expect(readme).toContain("Langfuse");
    expect(readme).toContain("trace in Langfuse");
    expect(readme).toContain("nub run council decision-council run");
    expect(readme).toContain("BAML_LOG=warn");
    expect(readme).toContain("grep -i");
  });

  it("creates beads workflow and runs under generated runItem when --create-beads-workflow is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-cli-main-"));
    const inputPath = join(dir, "question.md");
    await writeFile(inputPath, "# Should we use Flue?\n\nAnalyze this question.", "utf8");

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const argvSnapshot = process.argv;
    process.argv = ["node", "weavekit", "decision-council", "run", "--input", inputPath, "--create-beads-workflow"];

    try {
      await expect(main()).resolves.toBeUndefined();

      expect(createDecisionCouncilBeadsWorkflowMock).toHaveBeenCalledTimes(1);
      expect(createDecisionCouncilBeadsWorkflowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Should we use Flue?",
          inputPath,
          outputDir: "runs/latest",
        }),
      );

      expect(serializeWorkItemWorkflowDagMock).toHaveBeenCalledTimes(1);
      expect(serializeWorkItemWorkflowDagMock).toHaveBeenCalledWith({
        rootItemId: "bd-root",
        activeItemId: "bd-run",
        items: [
          { id: "bd-root" },
          { id: "bd-run" },
          { id: "bd-review" },
          { id: "bd-follow" },
        ],
      });

      expect(runDecisionCouncilMock).toHaveBeenCalledTimes(1);
      expect(runDecisionCouncilMock).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          workQueue: expect.objectContaining({
            workItemId: "bd-run",
            claimOnStart: true,
            closeOnSuccess: true,
            createFollowUp: false,
          }),
          workQueueWorkflowDag: expect.objectContaining({
            rootItemId: "bd-root",
            activeItemId: "bd-run",
          }),
        }),
      );

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("Use Flue"));
    } finally {
      process.argv = argvSnapshot;
      stdoutSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
