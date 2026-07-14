import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectVerificationRequirements,
  fingerprintProjectVerificationCase,
  formatProjectVerificationPrompt,
  formatProjectVerificationReference,
  loadProjectVerificationCase,
} from "../../../src/eval/sourceToProjectVerification/case.js";
import type { ProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";

describe("source-to-project verification case", () => {
  it.each([
    "todo-safe-write-path",
    "eslint-to-oxlint",
    "github-pattern-transfer",
    "evidence-backed-partial-adoption",
  ])("loads and fingerprints %s", async (caseId) => {
    const definition = loadProjectVerificationCase(`evals/source-to-project/cases/${caseId}.yaml`);
    expect(definition.id).toBe(caseId);
    expect(definition.expectedPractices.length).toBeGreaterThan(0);
    expect(await fingerprintProjectVerificationCase(definition)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves fixture paths relative to the case file and renders the judge contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-case-"));
    const projectDir = join(root, "project");
    const sourcePath = join(root, "source.md");
    const casePath = join(root, "case.yaml");
    await mkdir(projectDir);
    await writeFile(sourcePath, "# Safe writes\n", "utf8");
    await writeFile(
      casePath,
      `
id: todo-safe-write
title: Safe todo write path
objective: Apply the source practices to this project.
projectDir: ./project
sourcePath: ./source.md
expectedPractices:
  - id: validate-boundaries
    title: Validate request boundaries
    sourceExpectation: Parse and normalize untrusted request bodies.
    projectEvidence:
      - src/server.ts trusts req.body.title.
    expectedPlanActions:
      - Add a schema and return structured 400 responses.
antiGoals:
  - Do not replace the application framework.
rubric:
  - criterion: practice-coverage
    weight: 0.6
    levels: 1.0 covers the applicable source practice; 0.0 misses it.
  - criterion: project-specificity
    weight: 0.4
    levels: 1.0 cites concrete project evidence; 0.0 is generic.
`,
      "utf8",
    );

    const definition = loadProjectVerificationCase(casePath);
    const prompt = formatProjectVerificationPrompt(definition);
    const reference = formatProjectVerificationReference(definition);
    const requirements = buildProjectVerificationRequirements(definition);

    expect(definition.projectDir).toBe(projectDir);
    expect(definition.sourcePath).toBe(sourcePath);
    expect(prompt).toContain("Produce an implementation plan only");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("./project");
    expect(prompt).toContain("./source.md");
    expect(reference).toContain("validate-boundaries");
    expect(reference).toContain("src/server.ts trusts req.body.title");
    expect(reference).toContain("Do not replace the application framework");
    expect(requirements).toEqual([
      {
        id: "validate-boundaries/action-1",
        practiceId: "validate-boundaries",
        practiceTitle: "Validate request boundaries",
        action: "Add a schema and return structured 400 responses.",
        sourceExpectation: "Parse and normalize untrusted request bodies.",
        projectEvidence: ["src/server.ts trusts req.body.title."],
      },
    ]);
    expect(reference).toContain("Requirement validate-boundaries/action-1");

    const originalFingerprint = await fingerprintProjectVerificationCase(definition);
    await writeFile(sourcePath, "# Changed source\n", "utf8");
    const changedFingerprint = await fingerprintProjectVerificationCase(definition);
    expect(originalFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(changedFingerprint).not.toBe(originalFingerprint);
  });

  it("rejects rubric weights that do not sum to one", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-invalid-"));
    await mkdir(join(root, "project"));
    await writeFile(join(root, "source.md"), "# Source\n", "utf8");
    const casePath = join(root, "case.yaml");
    await writeFile(
      casePath,
      `
id: invalid-case
title: Invalid
objective: Invalid
projectDir: ./project
sourcePath: ./source.md
expectedPractices:
  - id: validation
    title: Validation
    sourceExpectation: Validate input.
    projectEvidence: [missing validation]
    expectedPlanActions: [add validation]
rubric:
  - criterion: practice-coverage
    weight: 0.8
    levels: complete
`,
      "utf8",
    );

    expect(() => loadProjectVerificationCase(casePath)).toThrow(/weights must sum to 1/i);
  });

  it("rejects duplicate derived requirement ids", () => {
    const definition = {
      id: "duplicate-requirements",
      title: "Duplicate requirements",
      objective: "Reject ambiguous judge contracts.",
      projectDir: "/tmp/project",
      sourcePath: "/tmp/source.md",
      expectedPractices: [
        {
          id: "validation",
          title: "First validation practice",
          sourceExpectation: "Validate input.",
          projectEvidence: ["server.ts"],
          expectedPlanActions: ["Add validation."],
        },
        {
          id: "validation",
          title: "Duplicate validation practice",
          sourceExpectation: "Validate another input.",
          projectEvidence: ["routes.ts"],
          expectedPlanActions: ["Add another validation."],
        },
      ],
      antiGoals: [],
      rubric: [{ criterion: "coverage", weight: 1, levels: "Complete coverage." }],
    } satisfies ProjectVerificationCase;

    expect(() => buildProjectVerificationRequirements(definition)).toThrow(
      /duplicate requirement id.*validation\/action-1/i,
    );
  });
});
