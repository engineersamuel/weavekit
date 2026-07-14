import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractWeavekitPlan } from "../../../src/eval/sourceToProjectVerification/weavekitPlan.js";

describe("weavekit source-to-project plan extraction", () => {
  it("prefers the full canonical portfolio plan over its short transcript", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "weavekit-project-verification-plan-"));
    const rawPlansDir = join(runDir, "raw-plans");
    await mkdir(rawPlansDir);
    await writeFile(join(rawPlansDir, "plan-portfolio.md"), "Let me write it.\n", "utf8");
    await writeFile(
      join(rawPlansDir, "plan-portfolio-full.md"),
      "# Full implementation plan\n",
      "utf8",
    );

    const extracted = await extractWeavekitPlan(runDir);

    expect(extracted.kind).toBe("full-plan");
    expect(extracted.markdown).toBe("# Full implementation plan\n");
  });

  it("rejects a workflow report when no canonical portfolio plan exists", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "weavekit-project-verification-report-"));
    await writeFile(
      join(runDir, "workflow-report.md"),
      "# Macro Workflow Run Report\n\nNo selected improvement plans were recorded.\n",
      "utf8",
    );

    await expect(extractWeavekitPlan(runDir)).rejects.toThrow(/canonical portfolio plan/i);
  });

  it("rejects child opportunity plans when no canonical portfolio exists", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "weavekit-project-verification-mixed-plans-"));
    const rawPlansDir = join(runDir, "raw-plans");
    await mkdir(rawPlansDir);
    await writeFile(join(rawPlansDir, "plan-opportunity-a.md"), "short A\n", "utf8");
    await writeFile(join(rawPlansDir, "plan-opportunity-a-full.md"), "# Full A\n", "utf8");
    await writeFile(join(rawPlansDir, "plan-opportunity-b.md"), "# Raw B\n", "utf8");

    await expect(extractWeavekitPlan(runDir)).rejects.toThrow(/canonical portfolio plan/i);
  });

  it("uses only the canonical portfolio plan when one is available", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "weavekit-project-verification-portfolio-"));
    const rawPlansDir = join(runDir, "raw-plans");
    await mkdir(rawPlansDir);
    await writeFile(join(rawPlansDir, "plan-opportunity-a-full.md"), "# Partial A\n", "utf8");
    await writeFile(join(rawPlansDir, "plan-opportunity-b.md"), "# Partial B\n", "utf8");
    await writeFile(join(rawPlansDir, "plan-portfolio.md"), "short portfolio\n", "utf8");
    await writeFile(
      join(rawPlansDir, "plan-portfolio-full.md"),
      "# Canonical portfolio plan\n",
      "utf8",
    );

    const extracted = await extractWeavekitPlan(runDir);

    expect(extracted.kind).toBe("full-plan");
    expect(extracted.markdown).toBe("# Canonical portfolio plan\n");
    expect(extracted.paths).toEqual([join(rawPlansDir, "plan-portfolio-full.md")]);
  });
});
