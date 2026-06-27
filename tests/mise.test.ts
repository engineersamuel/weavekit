import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";

describe("mise tasks", () => {
  it("defines a local Beads telemetry task for the generated decision-council workflow", () => {
    const mise = parse(readFileSync(resolve(process.cwd(), ".mise.toml"), "utf8")) as {
      tasks?: Record<string, { description?: string; run?: string }>;
    };
    const task = mise.tasks?.["council:telemetry-local-beads"];

    expect(task).toBeDefined();
    expect(task?.description).toContain("Beads");
    expect(task?.run).toContain("source .env.fish");
    expect(task?.run).toContain("set -e OTEL_SDK_DISABLED");
    expect(task?.run).toContain("decision-council run");
    expect(task?.run).toContain("--input examples/design-question.md");
    expect(task?.run).toContain("--output runs/telemetry-local-beads");
    expect(task?.run).toContain("--max-rounds 3");
    expect(task?.run).toContain("--create-beads-workflow");
    expect(task?.run).not.toContain("--sync-work-queue");
  });
});
