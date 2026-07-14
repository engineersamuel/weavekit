import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ExtractedWeavekitPlan = {
  kind: "full-plan" | "raw-plan";
  markdown: string;
  paths: string[];
};

export async function extractWeavekitPlan(runDir: string): Promise<ExtractedWeavekitPlan> {
  const rawPlansDir = join(runDir, "raw-plans");
  const planFiles = await readPlanFiles(rawPlansDir);
  const portfolioFile = planFiles.includes("plan-portfolio-full.md")
    ? "plan-portfolio-full.md"
    : planFiles.includes("plan-portfolio.md")
      ? "plan-portfolio.md"
      : undefined;
  if (!portfolioFile) {
    throw new Error(
      `Weavekit run is missing a canonical portfolio plan in ${rawPlansDir}; child plans and workflow reports are diagnostics only.`,
    );
  }
  return readPlans(
    rawPlansDir,
    [portfolioFile],
    portfolioFile.endsWith("-full.md") ? "full-plan" : "raw-plan",
  );
}

async function readPlanFiles(rawPlansDir: string): Promise<string[]> {
  try {
    return (await readdir(rawPlansDir)).sort();
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }
}

async function readPlans(
  rawPlansDir: string,
  files: string[],
  kind: ExtractedWeavekitPlan["kind"],
): Promise<ExtractedWeavekitPlan> {
  const paths = files.map((file) => join(rawPlansDir, file));
  const plans = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  return { kind, markdown: plans.join("\n\n---\n\n"), paths };
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
