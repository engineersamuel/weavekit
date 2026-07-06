import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeMacroWorkflowArtifacts } from "../../../src/macro-workflow/artifacts.js";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import {
  createDeepResearchDynamicExpander,
  createDefaultDeepResearchExaMcpConnection,
  createExaMcpClientFromTools,
  createDeepResearchHarnessRegistry,
  type DeepResearchProviderClient,
} from "../../../src/macro-workflow/deepResearch/harnesses.js";

describe("deep-research harnesses", () => {
  it("fans out provider research, assesses coverage, and compiles markdown", async () => {
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research durable agent workflows",
      providers: ["exa", "grok"],
      maxIterations: 2,
      questionsPerIteration: 2,
      maxResultsPerQuestion: 2,
    });
    const providerCalls: string[] = [];
    const bamlCalls: string[] = [];
    const provider = (name: string): DeepResearchProviderClient => ({
      async search(args) {
        providerCalls.push(`${name}:${args.queries.join("|")}`);
        return [{
          provider: name,
          questionId: args.questions[0]?.id ?? "unknown",
          query: args.queries[0] ?? "",
          url: `https://example.com/${name}`,
          title: `${name} result`,
          excerpt: `${name} excerpt`,
          content: `${name} content`,
          sourceQuality: "primary",
          provenance: name === "grok" ? "grok cli with x_search" : "exa mcp web_search_exa/web_fetch_exa",
        }];
      },
    });

    const harnesses = createDeepResearchHarnessRegistry({
      baml: {
        async GenerateResearchQuestions(_prompt, _priorState, config) {
          bamlCalls.push(`questions:${config.maxIterations}`);
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What patterns make agent workflows durable?",
              rationale: "Core objective coverage.",
              priority: 1,
              providerHints: ["exa", "grok"],
              searchQueries: ["durable agent workflows"],
              completionCriteria: ["Find concrete patterns."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          bamlCalls.push(`assess:${evidence.length}`);
          return {
            iteration: 1,
            questionCoverage: [{
              questionId: "q1",
              coverageScore: 0.9,
              evidenceQuality: "high",
              contradictions: [],
              gaps: [],
            }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "coverage sufficient",
          };
        },
        async CompileDeepResearchReport(_prompt, finalState) {
          bamlCalls.push(`report:${finalState.evidence.length}`);
          return {
            markdown: "# Deep Research Report\n\nUse bounded in-process loops.",
          };
        },
      },
      providers: {
        exa: provider("exa"),
        grok: provider("grok"),
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
    expect(providerCalls).toEqual([
      "exa:durable agent workflows",
      "grok:durable agent workflows",
    ]);
    expect(bamlCalls).toEqual(["questions:2", "assess:2", "report:2"]);
    expect(state.currentPlan.nodes.map((node) => node.id)).toEqual([
      "deep-research-questions-1",
      "deep-research-exa-1",
      "deep-research-grok-1",
      "deep-research-assess-1",
      "deep-research-report",
    ]);
    expect(state.nodeResults.find((result) => result.nodeId === "deep-research-report")?.payload).toMatchObject({
      deepResearchReport: {
        objective: "Research durable agent workflows",
        methodology: expect.stringContaining("Collected 2 normalized evidence item(s)"),
        evidenceMatrix: [
          expect.objectContaining({ questionId: "q1", evidenceId: "exa-1-1" }),
          expect.objectContaining({ questionId: "q1", evidenceId: "grok-1-1" }),
        ],
        sources: [
          expect.objectContaining({ id: "exa-1-1", provider: "exa", url: "https://example.com/exa" }),
          expect.objectContaining({ id: "grok-1-1", provider: "grok", url: "https://example.com/grok" }),
        ],
        markdown: expect.stringContaining("# Deep Research Report"),
      },
    });
  });

  it("returns a clear unsupported-provider failure for accepted provider stubs", async () => {
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research durable agent workflows",
      providers: ["tavily"],
    });
    const harnesses = createDeepResearchHarnessRegistry({
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What exists?",
              rationale: "Need sources.",
              priority: 1,
              providerHints: ["tavily"],
              searchQueries: ["agent research"],
              completionCriteria: ["Find sources."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration() {
          throw new Error("assessment should not run");
        },
        async CompileDeepResearchReport() {
          throw new Error("report should not run");
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("failed");
    expect(state.nodeResults.find((result) => result.nodeId === "deep-research-tavily-1")).toMatchObject({
      status: "failed",
      error: "Deep research provider tavily is accepted but not implemented/configured for this MVP.",
    });
  });

  it("runs copilot-last30days through the last30days skill and normalizes one evidence item per question", async () => {
    const skillsRoot = await mkdtemp(join(tmpdir(), "deep-research-skills-"));
    await mkdir(join(skillsRoot, "last30days"), { recursive: true });
    await writeFile(join(skillsRoot, "last30days", "SKILL.md"), "# last30days\n", "utf8");
    await mkdir(join(skillsRoot, "other-skill"), { recursive: true });
    await writeFile(join(skillsRoot, "other-skill", "SKILL.md"), "# other skill\n", "utf8");
    const copilotCalls: unknown[] = [];
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research recent agent workflow discussion",
      providers: ["copilot-last30days"],
      maxResultsPerQuestion: 2,
    });

    const harnesses = createDeepResearchHarnessRegistry({
      tooling: { skillsDirectory: skillsRoot },
      copilot: {
        async run(args) {
          copilotCalls.push(args);
          return [
            "# Last 30 Days Research",
            "",
            "Developers discussed agent workflow reliability, evidence collection, and execution traces across community sources.",
          ].join("\n");
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "What are developers saying about agent workflow reliability?",
                rationale: "Need recent community evidence.",
                priority: 1,
                providerHints: ["copilot-last30days"],
                searchQueries: ["agent workflow reliability"],
                completionCriteria: ["Find recent discussion."],
                status: "pending",
                dependencies: [],
              },
              {
                id: "q2",
                text: "Which traces do users want?",
                rationale: "Need product signals.",
                priority: 1,
                providerHints: ["copilot-last30days"],
                searchQueries: ["agent workflow traces"],
                completionCriteria: ["Find recent discussion."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          expect(evidence).toHaveLength(2);
          expect(evidence[0]).toMatchObject({
            provider: "copilot-last30days",
            questionId: "q1",
            query: "agent workflow reliability",
            title: "last30days research for q1",
            excerpt: expect.stringContaining("Developers discussed"),
            content: expect.stringContaining("Last 30 Days Research"),
            sourceQuality: "community",
            provenance: "copilot sdk with last30days skill",
          });
          return {
            iteration: 1,
            questionCoverage: [{ questionId: "q1", coverageScore: 1, evidenceQuality: "community", contradictions: [], gaps: [] }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "complete",
          };
        },
        async CompileDeepResearchReport() {
          return {
            markdown: "# Deep Research Report",
          };
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
    expect(state.currentPlan.nodes.map((node) => node.id)).toContain("deep-research-copilot-last30days-1");
    expect(copilotCalls).toEqual([expect.objectContaining({
      mode: "research",
      model: "gpt-5.5",
      maxToolCalls: 60,
      operation: "deep-research-copilot-last30days-1",
      capabilityScope: {
        kind: "skill",
        skillName: "last30days",
        skillDirectories: [skillsRoot],
        disabledSkills: ["other-skill"],
      },
    })]);
    expect(copilotCalls[0]).toMatchObject({
      prompt: expect.stringContaining("/last30days"),
    });
  });

  it("fails copilot-last30days clearly when the last30days skill is not installed", async () => {
    const skillsRoot = await mkdtemp(join(tmpdir(), "deep-research-missing-skills-"));
    const cwd = await mkdtemp(join(tmpdir(), "deep-research-missing-cwd-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "deep-research-missing-home-"));
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research recent agent workflow discussion",
      providers: ["copilot-last30days"],
    });

    const harnesses = createDeepResearchHarnessRegistry({
      tooling: { skillsDirectory: skillsRoot },
      cwd,
      homeDirectory,
      copilot: {
        async run() {
          throw new Error("copilot should not run without the skill");
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What are developers saying?",
              rationale: "Need recent community evidence.",
              priority: 1,
              providerHints: ["copilot-last30days"],
              searchQueries: ["agent workflow reliability"],
              completionCriteria: ["Find recent discussion."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration() {
          throw new Error("assessment should not run");
        },
        async CompileDeepResearchReport() {
          throw new Error("report should not run");
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("failed");
    expect(state.nodeResults.find((result) => result.nodeId === "deep-research-copilot-last30days-1")?.error).toContain(
      "Install it with `nubx skills add mvanhorn/last30days-skill -g`.",
    );
  });

  it("writes a human-readable markdown report when BAML report parsing fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "deep-research-report-"));
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research durable agent workflows",
      providers: ["exa"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
    });

    const harnesses = createDeepResearchHarnessRegistry({
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What makes agent workflows durable?",
              rationale: "Need durable workflow evidence.",
              priority: 1,
              providerHints: ["exa"],
              searchQueries: ["durable agent workflows"],
              completionCriteria: ["Find one cited source."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration(_questionSet, _evidence, _priorState) {
          return {
            iteration: 1,
            questionCoverage: [{
              questionId: "q1",
              coverageScore: 0.7,
              evidenceQuality: "medium",
              contradictions: [],
              gaps: ["Need more production case studies."],
            }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: false,
            stopReason: "Max iterations reached with enough evidence for a limited report.",
          };
        },
        async CompileDeepResearchReport() {
          throw new Error("BamlValidationError: Missing required field: markdown");
        },
      },
      providers: {
        exa: {
          async search() {
            return [{
              provider: "exa",
              questionId: "q1",
              query: "durable agent workflows",
              url: "https://example.com/durable-agents",
              title: "Durable Agents",
              excerpt: "Durable agents persist state, retry work, and resume after failures.",
              content: "Long source content that should not be required for fallback markdown.",
              sourceQuality: "primary",
              provenance: "exa mcp web_search_exa",
            }];
          },
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
      outputDir,
    });

    const reportResult = state.nodeResults.find((result) => result.nodeId === "deep-research-report");
    await writeMacroWorkflowArtifacts({ outputDir, state });
    const markdown = await readFile(join(outputDir, "DeepResearchReport.md"), "utf8");

    expect(state.status).toBe("failed");
    expect(reportResult).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Missing required field: markdown"),
      payload: {
        deepResearchReport: {
          markdown: expect.stringContaining("# Deep Research Report"),
          sources: [{
            id: "exa-1-1",
            provider: "exa",
            url: "https://example.com/durable-agents",
            title: "Durable Agents",
            quality: "primary",
          }],
        },
      },
    });
    expect(reportResult?.output).toContain("BAML report compilation failed");
    expect(markdown).toContain("Durable agents persist state");
    expect(markdown).toContain("https://example.com/durable-agents");
    const payload = JSON.parse(await readFile(join(outputDir, "deep-research-report.payload.json"), "utf8")) as {
      deepResearchReport?: { markdown?: string };
    };
    expect(payload.deepResearchReport?.markdown).toContain("# Deep Research Report");
  });

  it("fails report compilation when the compiler returns a non-report markdown value", async () => {
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research durable agent workflows",
      providers: ["exa"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
    });

    const harnesses = createDeepResearchHarnessRegistry({
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What makes agent workflows durable?",
              rationale: "Need durable workflow evidence.",
              priority: 1,
              providerHints: ["exa"],
              searchQueries: ["durable agent workflows"],
              completionCriteria: ["Find one cited source."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration() {
          return {
            iteration: 1,
            questionCoverage: [{ questionId: "q1", coverageScore: 1, evidenceQuality: "high", contradictions: [], gaps: [] }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "complete",
          };
        },
        async CompileDeepResearchReport() {
          return {
            markdown: "{objective: Research durable agent workflows, methodology: old structured response without markdown}",
          };
        },
      },
      providers: {
        exa: {
          async search() {
            return [{
              provider: "exa",
              questionId: "q1",
              query: "durable agent workflows",
              title: "Durable Agents",
              excerpt: "Durable agents persist state.",
              sourceQuality: "primary",
              provenance: "exa mcp web_search_exa",
            }];
          },
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("failed");
    expect(state.nodeResults.find((result) => result.nodeId === "deep-research-report")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("required Markdown report heading"),
      payload: {
        deepResearchReport: {
          markdown: expect.stringContaining("BAML report compilation failed"),
        },
      },
    });
  });

  it("adapts installed Exa MCP tools into the default Exa provider seam", async () => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const exaMcp = createExaMcpClientFromTools([
      {
        name: "mcp__exa__web_search_exa",
        async run({ input }) {
          calls.push({ tool: "search", input });
          return {
            results: [{
              url: "https://example.com/exa",
              title: "Exa result",
              text: "Search excerpt",
            }],
          };
        },
      },
      {
        name: "mcp__exa__web_fetch_exa",
        async run({ input }) {
          calls.push({ tool: "fetch", input });
          return { content: "Fetched page content" };
        },
      },
    ]);

    expect(exaMcp).toBeDefined();
    const harnesses = createDeepResearchHarnessRegistry({
      exaMcp,
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What does Exa find?",
              rationale: "Need web evidence.",
              priority: 1,
              providerHints: ["exa"],
              searchQueries: ["exa deep research"],
              completionCriteria: ["Find one source."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          expect(evidence[0]).toMatchObject({
            provider: "exa",
            questionId: "q1",
            query: "exa deep research",
            url: "https://example.com/exa",
            title: "Exa result",
            excerpt: "Search excerpt",
            content: "Fetched page content",
          });
          return {
            iteration: 1,
            questionCoverage: [{ questionId: "q1", coverageScore: 1, evidenceQuality: "high", contradictions: [], gaps: [] }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "complete",
          };
        },
        async CompileDeepResearchReport() {
          return {
            markdown: "# Deep Research Report",
          };
        },
      },
    });
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research with Exa",
      providers: ["exa"],
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
    expect(calls).toEqual([
      { tool: "search", input: { query: "exa deep research", numResults: 5 } },
      { tool: "fetch", input: { url: "https://example.com/exa" } },
    ]);
  });

  it("retries a failing provider node using the same provider prompt and config", async () => {
    const searchCalls: Array<{ query: string; numResults?: number }> = [];
    const harnesses = createDeepResearchHarnessRegistry({
      config: {
        providers: ["exa"],
        maxIterations: 1,
        questionsPerIteration: 1,
        maxResultsPerQuestion: 1,
        providerRetryAttempts: 1,
        visualize: false,
      },
      exaMcp: {
        async web_search_exa(args) {
          searchCalls.push(args);
          if (searchCalls.length === 1) {
            throw new Error("web_search_exa error (403): The following requested domains are not available: x.com. Remove them from includeDomains and try again.");
          }
          return {
            results: [{
              url: "https://example.com/typescript-linter",
              title: "TypeScript linter comparison",
              text: "Biome, oxlint, and ESLint have different performance and completeness tradeoffs.",
            }],
          };
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "Which TypeScript linter is fastest and most complete?",
              rationale: "Need current linter evidence.",
              priority: 1,
              providerHints: ["exa"],
              searchQueries: ["site:x.com TypeScript linter Biome Oxlint ESLint"],
              completionCriteria: ["Find one source."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          expect(evidence).toHaveLength(1);
          expect(evidence[0]).toMatchObject({
            provider: "exa",
            query: "site:x.com TypeScript linter Biome Oxlint ESLint",
            title: "TypeScript linter comparison",
          });
          return {
            iteration: 1,
            questionCoverage: [{ questionId: "q1", coverageScore: 1, evidenceQuality: "medium", contradictions: [], gaps: [] }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "complete",
          };
        },
        async CompileDeepResearchReport() {
          return {
            objective: "Research",
            methodology: "Retried provider research",
            findings: [],
            evidenceMatrix: [],
            contradictions: [],
            gaps: [],
            confidence: "medium",
            sources: [],
            markdown: "# Deep Research Report",
          };
        },
      },
    });
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research TypeScript linters",
      providers: ["exa"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
      providerRetryAttempts: 1,
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
    expect(searchCalls).toEqual([
      { query: "site:x.com TypeScript linter Biome Oxlint ESLint", numResults: 1 },
      { query: "site:x.com TypeScript linter Biome Oxlint ESLint", numResults: 1 },
    ]);
    expect(state.nodeResults.find((result) => result.nodeId === "deep-research-exa-1")?.output).toContain("after 1 retry");
  });

  it("normalizes Exa MCP text search output into cited evidence", async () => {
    const harnesses = createDeepResearchHarnessRegistry({
      exaMcp: {
        async web_search_exa() {
          return {
            content: [
              "Title: Durable Agents",
              "URL: https://example.com/durable-agents",
              "Published: N/A",
              "Author: N/A",
              "Highlights:",
              "Durable agents persist each tool call and resume after failure.",
            ].join("\n"),
          };
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [{
              id: "q1",
              text: "What makes agents durable?",
              rationale: "Need cited source.",
              priority: 1,
              providerHints: ["exa"],
              searchQueries: ["durable agent workflows"],
              completionCriteria: ["Find one source."],
              status: "pending",
              dependencies: [],
            }],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          expect(evidence[0]).toMatchObject({
            provider: "exa",
            questionId: "q1",
            query: "durable agent workflows",
            url: "https://example.com/durable-agents",
            title: "Durable Agents",
            excerpt: expect.stringContaining("persist each tool call"),
          });
          return {
            iteration: 1,
            questionCoverage: [{ questionId: "q1", coverageScore: 1, evidenceQuality: "high", contradictions: [], gaps: [] }],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "complete",
          };
        },
        async CompileDeepResearchReport() {
          return {
            markdown: "# Deep Research Report",
          };
        },
      },
    });
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research with Exa text output",
      providers: ["exa"],
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
  });

  it("connects the configured Exa MCP server for the default Exa provider and closes it", async () => {
    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async ({ arguments: input }: { arguments?: Record<string, unknown> }) => ({
      structuredContent: { results: [{ url: "https://example.com", title: "Result", text: String(input?.query) }] },
    }));
    const connect = vi.fn(async () => ({
      async listTools() {
        return { tools: [{ name: "web_search_exa" }] };
      },
      callTool,
      close,
    }));

    const connection = await createDefaultDeepResearchExaMcpConnection({
      env: { EXA_API_KEY: "exa-secret" },
      connectMcpClient: connect,
    });

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      name: "exa",
      url: expect.stringContaining("exa-secret"),
    }));
    await expect(connection.client?.web_search_exa({ query: "agent research", numResults: 2 }))
      .resolves.toMatchObject({ results: [{ title: "Result" }] });
    expect(callTool).toHaveBeenCalledWith({
      name: "web_search_exa",
      arguments: { query: "agent research", numResults: 2 },
    });

    await connection.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not call Flue MCP tool definitions directly for the default Exa provider", async () => {
    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({ results: [{ url: "https://example.com/exa", title: "Exa" }] }),
      }],
    }));
    const connect = vi.fn(async () => ({
      async listTools() {
        return { tools: [{ name: "mcp__exa__web_search_exa" }] };
      },
      callTool,
      close,
    }));

    const connection = await createDefaultDeepResearchExaMcpConnection({
      env: { EXA_API_KEY: "exa-secret" },
      connectMcpClient: connect,
    });

    await expect(connection.client?.web_search_exa({ query: "agent research", numResults: 2 }))
      .resolves.toMatchObject({ results: [{ title: "Exa" }] });
    expect(callTool).toHaveBeenCalledWith({
      name: "web_search_exa",
      arguments: { query: "agent research", numResults: 2 },
    });

    await connection.close();
  });
});
