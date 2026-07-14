import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkflowCli } from "../../../src/cli.js";
import * as sourceToProjectHarnesses from "../../../src/macro-workflow/sourceToProject/harnesses.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("source-to-project CLI run", () => {
  it("forwards canonical-only portfolio planning to the dynamic expander", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-to-project-direct-portfolio-"));
    tempDirs.push(root);
    const outputRoot = join(root, "runs");
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      `
[source_to_project]
offline = true

[projects.weavekit]
display_name = "Weavekit"
working_tree = "${root}"
mainline = "origin main"
remote = "origin"
context_docs = []
validation_commands = []
autonomous_pr_allowed = false
`,
      "utf8",
    );
    const createDynamicExpander = sourceToProjectHarnesses.createSourceToProjectDynamicExpander;
    let observedPortfolioPlanningMode: unknown;
    vi.spyOn(sourceToProjectHarnesses, "createSourceToProjectDynamicExpander").mockImplementation(
      (options) => {
        observedPortfolioPlanningMode = options.portfolioPlanningMode;
        return createDynamicExpander(options);
      },
    );

    await runWorkflowCli({
      command: "run",
      outputDir: outputRoot,
      staticTemplate: true,
      dryRun: false,
      template: "source-to-project",
      prompt: "Apply the source through one canonical portfolio plan.",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "advisory",
      includeVisualDesign: false,
      portfolioPlanningMode: "direct",
      configPath,
    });

    expect(observedPortfolioPlanningMode).toBe("direct");
  });

  it("writes source-to-project artifacts for advisory mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-to-project-run-"));
    tempDirs.push(root);
    const outputRoot = join(root, "runs");
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      `
[source_to_project]
offline = true

[projects.weavekit]
display_name = "Weavekit"
working_tree = "${root}"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md"]
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = false
`,
      "utf8",
    );

    await runWorkflowCli({
      command: "run",
      outputDir: outputRoot,
      staticTemplate: true,
      dryRun: false,
      template: "source-to-project",
      prompt: "Read and analyze source for secondbrain",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "advisory",
      includeVisualDesign: false,
      configPath,
    });

    const [runDir] = await readdir(outputRoot);
    const state = await readFile(join(outputRoot, runDir!, "workflow-state.json"), "utf8");
    const report = await readFile(join(outputRoot, runDir!, "workflow-report.md"), "utf8");

    expect(state).toContain('"templateId": "source-to-project"');
    expect(state).toContain('"runName": "Read And Analyze Source For"');
    expect(state).toContain('"id": "audit-portfolio"');
    expect(state).toContain('"nodeId": "audit-portfolio"');
    expect(state).toContain('"id": "report-portfolio"');
    expect(state).toContain('"nodeId": "report-portfolio"');
    expect(state).not.toContain('"id": "visual-plan-preflight"');
    expect(state).not.toContain('"nodeId": "visual-plan-preflight"');
    expect(state).not.toContain('"id": "visual-design-opportunity-opp-1"');
    await expect(
      readFile(join(outputRoot, runDir!, "raw-plans/plan-portfolio-full.md"), "utf8"),
    ).resolves.toContain("/plan");
    expect(report).toContain("## Typed Payloads");
  });

  it("uses the prompt as the source artifact when no source URL is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-to-project-prompt-source-"));
    tempDirs.push(root);
    const outputRoot = join(root, "runs");
    const configPath = join(root, "config.toml");
    const prompt =
      "Use the team's internal loop maturity notes to identify weavekit workflow improvements.";
    await writeFile(
      configPath,
      `
[source_to_project]
offline = true

[projects.weavekit]
display_name = "Weavekit"
working_tree = "${root}"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md"]
validation_commands = []
autonomous_pr_allowed = false
`,
      "utf8",
    );

    await runWorkflowCli({
      command: "run",
      outputDir: outputRoot,
      staticTemplate: true,
      dryRun: false,
      template: "source-to-project",
      prompt,
      project: "weavekit",
      mode: "advisory",
      configPath,
    });

    const [runDir] = await readdir(outputRoot);
    const state = await readFile(join(outputRoot, runDir!, "workflow-state.json"), "utf8");

    expect(state).toContain("Use the team");
    expect(state).toContain("internal loop maturity notes");
    expect(state).toContain('"templateId": "source-to-project"');
    expect(state).toContain('"status": "passed"');
  });

  it("prefetches an explicit X source URL with grok before source-to-project reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-to-project-x-source-"));
    tempDirs.push(root);
    const outputRoot = join(root, "runs");
    const configPath = join(root, "config.toml");
    const binDir = join(root, "bin");
    const grokPath = join(binDir, "grok");
    await mkdir(binDir);
    await writeFile(
      grokPath,
      ["#!/bin/sh", "printf '# X Post\\n\\nFetched X source content.\\n'"].join("\n"),
      "utf8",
    );
    await chmod(grokPath, 0o755);
    await writeFile(
      configPath,
      `
[source_to_project]
offline = true

[projects.weavekit]
display_name = "Weavekit"
working_tree = "${root}"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md"]
validation_commands = []
autonomous_pr_allowed = false
`,
      "utf8",
    );
    const originalPath = process.env.PATH;
    process.env.PATH = originalPath ? `${binDir}${delimiter}${originalPath}` : binDir;

    try {
      await runWorkflowCli({
        command: "run",
        outputDir: outputRoot,
        staticTemplate: true,
        dryRun: false,
        template: "source-to-project",
        prompt: "Apply this source to weavekit.",
        source: "https://x.com/alice/status/12345",
        project: "weavekit",
        mode: "advisory",
        configPath,
        noCache: true,
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }

    const [runDir] = await readdir(outputRoot);
    const state = await readFile(join(outputRoot, runDir!, "workflow-state.json"), "utf8");

    expect(state).toContain("## Resolved X Post Sources");
    expect(state).toContain("https://x.com/alice/status/12345");
    expect(state).toContain("Fetched X source content.");
    expect(state).toContain(
      "Use the prefetched X post markdown below as the primary Source artifact.",
    );
  });
});
