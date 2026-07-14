import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_PROJECT_VERIFICATION_CASE_PATH =
  "evals/source-to-project/cases/todo-safe-write-path.yaml";

const ExpectedPracticeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "practice id must be kebab-case"),
  title: z.string().min(1),
  sourceExpectation: z.string().min(1),
  projectEvidence: z.array(z.string().min(1)).min(1),
  expectedPlanActions: z.array(z.string().min(1)).min(1),
});

const RubricCriterionSchema = z.object({
  criterion: z.string().regex(/^[a-z0-9-]+$/, "criterion must be kebab-case"),
  weight: z.number().gt(0).lte(1),
  levels: z.string().min(1),
});

const ProjectVerificationCaseFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "case id must be kebab-case"),
  title: z.string().min(1),
  objective: z.string().min(1),
  projectDir: z.string().min(1),
  sourcePath: z.string().min(1),
  expectedPractices: z.array(ExpectedPracticeSchema).min(1),
  antiGoals: z.array(z.string().min(1)).default([]),
  rubric: z
    .array(RubricCriterionSchema)
    .min(1)
    .refine(
      (rubric) => Math.abs(rubric.reduce((sum, criterion) => sum + criterion.weight, 0) - 1) < 1e-6,
      { message: "rubric weights must sum to 1.0" },
    ),
});

type ProjectVerificationCaseFile = z.infer<typeof ProjectVerificationCaseFileSchema>;
export type ExpectedPractice = z.infer<typeof ExpectedPracticeSchema>;
export type ProjectVerificationRubricCriterion = z.infer<typeof RubricCriterionSchema>;

export type ProjectVerificationRequirement = {
  id: string;
  practiceId: string;
  practiceTitle: string;
  action: string;
  sourceExpectation: string;
  projectEvidence: string[];
};

export type ProjectVerificationCase = Omit<
  ProjectVerificationCaseFile,
  "projectDir" | "sourcePath"
> & {
  projectDir: string;
  sourcePath: string;
};

export function loadProjectVerificationCase(
  casePath = DEFAULT_PROJECT_VERIFICATION_CASE_PATH,
): ProjectVerificationCase {
  const absoluteCasePath = resolve(casePath);
  const parsed = ProjectVerificationCaseFileSchema.parse(
    parseYaml(readFileSync(absoluteCasePath, "utf8")),
  );
  const caseDir = dirname(absoluteCasePath);
  const projectDir = resolve(caseDir, parsed.projectDir);
  const sourcePath = resolve(caseDir, parsed.sourcePath);
  assertPathExists(projectDir, "projectDir");
  assertPathExists(sourcePath, "sourcePath");
  return { ...parsed, projectDir, sourcePath };
}

export function formatProjectVerificationPrompt(definition: ProjectVerificationCase): string {
  return [
    definition.objective,
    "",
    "Read the source article at ./source.md and inspect the target project at ./project.",
    "Produce an implementation plan only. Do not modify files.",
    "Apply only source practices that are supported by concrete evidence in the target project.",
    "Tie every recommendation to specific project files or behaviors, give an ordered implementation outline, and include validation and non-regression checks.",
    "Do not replace the framework, add unrelated product features, or introduce infrastructure that the source and project do not justify.",
  ].join("\n");
}

export function formatProjectVerificationReference(definition: ProjectVerificationCase): string {
  const practices = definition.expectedPractices.flatMap((practice) => [
    `Practice ${practice.id}: ${practice.title}`,
    `Source expectation: ${practice.sourceExpectation}`,
    `Project evidence: ${practice.projectEvidence.join("; ")}`,
    ...buildProjectVerificationRequirements(definition)
      .filter((requirement) => requirement.practiceId === practice.id)
      .map((requirement) => `Requirement ${requirement.id}: ${requirement.action}`),
  ]);
  const antiGoals =
    definition.antiGoals.length === 0
      ? ["Anti-goals: none"]
      : [`Anti-goals: ${definition.antiGoals.join("; ")}`];
  return [
    `Case: ${definition.title}`,
    `Objective: ${definition.objective}`,
    ...practices,
    ...antiGoals,
  ].join("\n");
}

export function buildProjectVerificationRequirements(
  definition: ProjectVerificationCase,
): ProjectVerificationRequirement[] {
  const requirements = definition.expectedPractices.flatMap((practice) =>
    practice.expectedPlanActions.map((action, index) => ({
      id: `${practice.id}/action-${index + 1}`,
      practiceId: practice.id,
      practiceTitle: practice.title,
      action,
      sourceExpectation: practice.sourceExpectation,
      projectEvidence: [...practice.projectEvidence],
    })),
  );
  const seen = new Set<string>();
  for (const requirement of requirements) {
    if (seen.has(requirement.id)) {
      throw new Error(`Duplicate requirement id: ${requirement.id}`);
    }
    seen.add(requirement.id);
  }
  return requirements;
}

export async function fingerprintProjectVerificationCase(
  definition: ProjectVerificationCase,
): Promise<string> {
  const sourceSha256 = digest(await readFile(definition.sourcePath));
  const projectTree = await fingerprintProjectTree(definition.projectDir);
  return digest(
    JSON.stringify({
      id: definition.id,
      title: definition.title,
      objective: definition.objective,
      expectedPractices: definition.expectedPractices,
      antiGoals: definition.antiGoals,
      rubric: definition.rubric,
      sourceSha256,
      projectTree,
    }),
  );
}

async function fingerprintProjectTree(
  rootDir: string,
  currentDir = rootDir,
): Promise<Array<{ path: string; kind: "file" | "symlink"; sha256: string }>> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const fingerprints: Array<{ path: string; kind: "file" | "symlink"; sha256: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      fingerprints.push(...(await fingerprintProjectTree(rootDir, path)));
      continue;
    }
    const relativePath = relative(rootDir, path).split(sep).join("/");
    if (entry.isFile()) {
      fingerprints.push({ path: relativePath, kind: "file", sha256: digest(await readFile(path)) });
      continue;
    }
    if (entry.isSymbolicLink()) {
      fingerprints.push({
        path: relativePath,
        kind: "symlink",
        sha256: digest(await readlink(path)),
      });
    }
  }
  return fingerprints;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPathExists(path: string, field: string): void {
  if (!existsSync(path)) {
    throw new Error(`Project verification ${field} does not exist: ${path}`);
  }
}
