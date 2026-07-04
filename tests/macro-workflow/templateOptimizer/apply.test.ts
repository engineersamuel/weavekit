import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dryRunApplyTemplateOptimizerPackage } from "../../../src/macro-workflow/templateOptimizer/apply.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("template optimizer apply", () => {
  it("writes a dry-run apply summary for the final incumbent adoption tasks", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-apply-"));
    tempDirs.push(runsRoot);
    const runId = "run-1";
    const runDir = join(runsRoot, runId);
    await mkdir(runDir);
    await writeFile(
      join(runDir, "optimizer-run.json"),
      JSON.stringify({
        finalIncumbent: {
          id: "candidate-1",
          adoptionTasks: [
            {
              title: "Update template",
              kind: "template",
              filesLikelyTouched: ["src/macro-workflow/templates.ts"],
              newFiles: ["tests/macro-workflow/sourceToProject/template.test.ts"],
              description: "Update the template shape.",
              acceptanceChecks: ["typecheck passes", "source-to-project tests pass"],
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await dryRunApplyTemplateOptimizerPackage({ runsRoot, runId });

    expect(result).toEqual({ summaryPath: join(runDir, "apply-dry-run.md") });
    const summary = await readFile(result.summaryPath, "utf8");
    expect(summary).toContain("# Template Optimizer Apply Dry Run");
    expect(summary).toContain("- Candidate: candidate-1");
    expect(summary).toContain("### 1. Update template");
    expect(summary).toContain("- Kind: template");
    expect(summary).toContain("- Likely files: src/macro-workflow/templates.ts");
    expect(summary).toContain("- New files: tests/macro-workflow/sourceToProject/template.test.ts");
    expect(summary).toContain("Update the template shape.");
    expect(summary).toContain("- typecheck passes");
    expect(summary).toContain("- source-to-project tests pass");
  });

  it("records when the final incumbent has no adoption tasks", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-apply-"));
    tempDirs.push(runsRoot);
    const runId = "run-no-tasks";
    const runDir = join(runsRoot, runId);
    await mkdir(runDir);
    await writeFile(
      join(runDir, "optimizer-run.json"),
      JSON.stringify({
        finalIncumbent: {
          id: "candidate-no-tasks",
          adoptionTasks: [],
        },
      }),
      "utf8",
    );

    const result = await dryRunApplyTemplateOptimizerPackage({ runsRoot, runId });

    await expect(readFile(result.summaryPath, "utf8")).resolves.toContain("No adoption tasks recorded.");
  });

  it("rejects a candidate id that is not the final incumbent", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-apply-"));
    tempDirs.push(runsRoot);
    const runId = "run-candidate-mismatch";
    const runDir = join(runsRoot, runId);
    await mkdir(runDir);
    await writeFile(
      join(runDir, "optimizer-run.json"),
      JSON.stringify({
        finalIncumbent: {
          id: "candidate-1",
          adoptionTasks: [],
        },
      }),
      "utf8",
    );

    await expect(
      dryRunApplyTemplateOptimizerPackage({ runsRoot, runId, candidateId: "candidate-2" }),
    ).rejects.toThrow("Candidate candidate-2 is not the final incumbent (candidate-1)");
  });

  it("rejects a package whose final incumbent is missing adoption tasks", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-apply-"));
    tempDirs.push(runsRoot);
    const runId = "run-missing-tasks";
    const runDir = join(runsRoot, runId);
    await mkdir(runDir);
    await writeFile(
      join(runDir, "optimizer-run.json"),
      JSON.stringify({
        finalIncumbent: {
          id: "candidate-1",
        },
      }),
      "utf8",
    );

    await expect(dryRunApplyTemplateOptimizerPackage({ runsRoot, runId })).rejects.toThrow(
      "Optimizer run run-missing-tasks finalIncumbent.adoptionTasks must be an array.",
    );
  });

  it("rejects a package whose adoption task fields have the wrong shape", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-apply-"));
    tempDirs.push(runsRoot);
    const runId = "run-malformed-task";
    const runDir = join(runsRoot, runId);
    await mkdir(runDir);
    await writeFile(
      join(runDir, "optimizer-run.json"),
      JSON.stringify({
        finalIncumbent: {
          id: "candidate-1",
          adoptionTasks: [
            {
              title: "Update template",
              kind: "template",
              filesLikelyTouched: "src/macro-workflow/templates.ts",
              newFiles: [],
              description: "Update the template shape.",
              acceptanceChecks: ["typecheck passes"],
            },
          ],
        },
      }),
      "utf8",
    );

    await expect(dryRunApplyTemplateOptimizerPackage({ runsRoot, runId })).rejects.toThrow(
      "Optimizer run run-malformed-task finalIncumbent.adoptionTasks[0].filesLikelyTouched must be an array of strings.",
    );
  });

  it("rejects a package whose adoption task kind is not allowed", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-apply-"));
    tempDirs.push(runsRoot);
    const runId = "run-invalid-kind";
    const runDir = join(runsRoot, runId);
    await mkdir(runDir);
    await writeFile(
      join(runDir, "optimizer-run.json"),
      JSON.stringify({
        finalIncumbent: {
          id: "candidate-1",
          adoptionTasks: [
            {
              title: "Update template",
              kind: "bogus",
              filesLikelyTouched: ["src/macro-workflow/templates.ts"],
              newFiles: [],
              description: "Update the template shape.",
              acceptanceChecks: ["typecheck passes"],
            },
          ],
        },
      }),
      "utf8",
    );

    await expect(dryRunApplyTemplateOptimizerPackage({ runsRoot, runId })).rejects.toThrow(
      "Optimizer run run-invalid-kind finalIncumbent.adoptionTasks[0].kind must be one of: template, expander, test, docs.",
    );
  });
});
