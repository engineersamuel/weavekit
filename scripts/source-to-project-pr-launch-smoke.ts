import { loadLocalEnvFiles, loadTypedWeavekitConfig, resolveProjectCatalogEntry } from "../src/config.js";
import { launchSourceToProjectPrAgent } from "../src/macro-workflow/sourceToProject/prLauncher.js";

type SmokeArgs = {
  project?: string;
  prompt?: string;
  configPath?: string;
};

async function main() {
  loadLocalEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    throw new Error("Usage: nub scripts/source-to-project-pr-launch-smoke.ts --project <id> [--prompt <text>] [--config <path>]");
  }
  const config = loadTypedWeavekitConfig(args.configPath);
  const project = resolveProjectCatalogEntry(config, args.project);
  if (!project.autonomousPrAllowed) {
    throw new Error(`Project ${project.id} has autonomous_pr_allowed = false.`);
  }
  const samplePrompt = args.prompt ?? "Sample implementation prompt for verifying Weavekit -> Herdr PR launch.";
  const result = await launchSourceToProjectPrAgent({
    config: config.sourceToProject.prLauncher,
    context: {
      runId: `smoke-${Date.now()}`,
      nodeId: "visual-design-opportunity-smoke",
      objective: "Smoke test manual source-to-project PR launch.",
      source: "smoke-test",
      project,
      opportunityId: "smoke",
      opportunityTitle: "Smoke test PR launcher",
      reportMarkdown: [
        "# Source-to-Project Report: smoke",
        "",
        samplePrompt,
        "",
        "This is an opt-in integration smoke test for the manual PR launcher path.",
      ].join("\n"),
      recommendation: samplePrompt,
    },
  });

  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write("\n");
}

function parseArgs(argv: string[]): SmokeArgs {
  const parsed: SmokeArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      parsed.project = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      parsed.prompt = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--config") {
      parsed.configPath = readArgValue(argv, index);
      index += 1;
      continue;
    }
  }
  return parsed;
}

function readArgValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${argv[index]}.`);
  }
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
