import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdoptionTask, TemplateCandidate } from "../../generated/baml_client/index.js";

type ApplyCandidate = Pick<TemplateCandidate, "id"> & {
  adoptionTasks: AdoptionTask[];
};

const adoptionTaskKinds = [
  "template",
  "expander",
  "test",
  "docs",
] as const satisfies readonly AdoptionTask["kind"][];

export async function dryRunApplyTemplateOptimizerPackage(args: {
  runsRoot: string;
  runId: string;
  candidateId?: string;
}): Promise<{ summaryPath: string }> {
  const runDir = join(args.runsRoot, args.runId);
  const payload = JSON.parse(await readFile(join(runDir, "optimizer-run.json"), "utf8")) as unknown;
  const candidate = validateApplyCandidate(payload, args.runId);
  if (args.candidateId && args.candidateId !== candidate.id) {
    throw new Error(
      `Candidate ${args.candidateId} is not the final incumbent (${candidate.id}); candidate lookup is not implemented for dry-run apply.`,
    );
  }

  const summaryPath = join(runDir, "apply-dry-run.md");
  await writeFile(summaryPath, renderDryRunSummary({ runId: args.runId, candidate }), "utf8");
  return { summaryPath };
}

function validateApplyCandidate(payload: unknown, runId: string): ApplyCandidate {
  const root = requireRecord(payload, runId, "optimizer-run.json");
  const finalIncumbent = requireRecord(root.finalIncumbent, runId, "finalIncumbent");
  const id = requireNonEmptyString(finalIncumbent.id, runId, "finalIncumbent.id");
  const adoptionTasks = requireArray(
    finalIncumbent.adoptionTasks,
    runId,
    "finalIncumbent.adoptionTasks",
  ).map((task, index) =>
    validateAdoptionTask(task, runId, `finalIncumbent.adoptionTasks[${index}]`),
  );
  return { id, adoptionTasks };
}

function validateAdoptionTask(task: unknown, runId: string, path: string): AdoptionTask {
  const record = requireRecord(task, runId, path);
  return {
    title: requireString(record.title, runId, `${path}.title`),
    kind: requireAdoptionTaskKind(record.kind, runId, `${path}.kind`),
    filesLikelyTouched: requireStringArray(
      record.filesLikelyTouched,
      runId,
      `${path}.filesLikelyTouched`,
    ),
    newFiles: requireStringArray(record.newFiles, runId, `${path}.newFiles`),
    description: requireString(record.description, runId, `${path}.description`),
    acceptanceChecks: requireStringArray(
      record.acceptanceChecks,
      runId,
      `${path}.acceptanceChecks`,
    ),
  };
}

function requireRecord(value: unknown, runId: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Optimizer run ${runId} ${path} must be an object.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, runId: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Optimizer run ${runId} ${path} must be a non-empty string.`);
  }
  return value;
}

function requireString(value: unknown, runId: string, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Optimizer run ${runId} ${path} must be a string.`);
  }
  return value;
}

function requireArray(value: unknown, runId: string, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Optimizer run ${runId} ${path} must be an array.`);
  }
  return value;
}

function requireAdoptionTaskKind(
  value: unknown,
  runId: string,
  path: string,
): AdoptionTask["kind"] {
  if (typeof value !== "string" || !isAdoptionTaskKind(value)) {
    throw new Error(
      `Optimizer run ${runId} ${path} must be one of: ${adoptionTaskKinds.join(", ")}.`,
    );
  }
  return value;
}

function requireStringArray(value: unknown, runId: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Optimizer run ${runId} ${path} must be an array of strings.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdoptionTaskKind(value: string): value is AdoptionTask["kind"] {
  return adoptionTaskKinds.some((kind) => kind === value);
}

function renderDryRunSummary(args: { runId: string; candidate: ApplyCandidate }): string {
  return [
    "# Template Optimizer Apply Dry Run",
    "",
    `- Run: ${args.runId}`,
    `- Candidate: ${args.candidate.id}`,
    "- Mode: dry-run",
    "",
    "Dry run only. No repository files were modified.",
    "",
    "## Planned Adoption Tasks",
    "",
    ...renderAdoptionTasks(args.candidate.adoptionTasks),
    "",
  ].join("\n");
}

function renderAdoptionTasks(tasks: AdoptionTask[]): string[] {
  if (tasks.length === 0) {
    return ["No adoption tasks recorded."];
  }

  return tasks.flatMap((task, index) => [
    `### ${index + 1}. ${task.title}`,
    "",
    `- Kind: ${task.kind}`,
    `- Likely files: ${renderInlineList(task.filesLikelyTouched)}`,
    `- New files: ${renderInlineList(task.newFiles)}`,
    "",
    task.description,
    "",
    "**Acceptance checks**",
    "",
    ...renderBulletList(task.acceptanceChecks),
    "",
  ]);
}

function renderInlineList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function renderBulletList(values: string[]): string[] {
  if (values.length === 0) {
    return ["- none"];
  }
  return values.map((value) => `- ${value}`);
}
