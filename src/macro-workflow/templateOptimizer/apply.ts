import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdoptionTask, TemplateCandidate } from "../../generated/baml_client/index.js";

type TemplateOptimizerApplyPayload = {
  finalIncumbent?: Pick<TemplateCandidate, "id" | "adoptionTasks">;
};

export async function dryRunApplyTemplateOptimizerPackage(args: {
  runsRoot: string;
  runId: string;
  candidateId?: string;
}): Promise<{ summaryPath: string }> {
  const runDir = join(args.runsRoot, args.runId);
  const payload = JSON.parse(await readFile(join(runDir, "optimizer-run.json"), "utf8")) as TemplateOptimizerApplyPayload;
  const candidate = payload.finalIncumbent;
  if (!candidate?.id) {
    throw new Error(`Optimizer run ${args.runId} does not include a finalIncumbent candidate.`);
  }
  if (args.candidateId && args.candidateId !== candidate.id) {
    throw new Error(
      `Candidate ${args.candidateId} is not the final incumbent (${candidate.id}); candidate lookup is not implemented for dry-run apply.`,
    );
  }

  const summaryPath = join(runDir, "apply-dry-run.md");
  await writeFile(summaryPath, renderDryRunSummary({ runId: args.runId, candidate }), "utf8");
  return { summaryPath };
}

function renderDryRunSummary(args: {
  runId: string;
  candidate: Pick<TemplateCandidate, "id" | "adoptionTasks">;
}): string {
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
