import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeMacroWorkflowArtifacts } from "../../../src/macro-workflow/artifacts.js";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import {
  WorkflowGateKind,
  WorkflowHarnessKind,
  WorkflowNodeKind,
  type RuntimeWorkflowNode,
  type WorkflowNodePayload,
} from "../../../src/macro-workflow/types.js";
import type { WorkflowExecutionContext } from "../../../src/macro-workflow/harness.js";
import {
  createDeepResearchDynamicExpander,
  createDefaultDeepResearchExaMcpConnection,
  createExaMcpClientFromTools,
  createDeepResearchHarnessRegistry,
  type DeepResearchProviderClient,
} from "../../../src/macro-workflow/deepResearch/harnesses.js";

describe("deep-research harnesses", () => {
  it("routes generated questions to providers by research mode instead of sending every question everywhere", async () => {
    const expander = createDeepResearchDynamicExpander();
    const seedNode = buildQuestionNodeFixture();
    const expansion = await expander({
      node: seedNode,
      result: {
        nodeId: seedNode.id,
        status: "passed",
        output: "Generated routed questions.",
        payload: {
          deepResearchQuestionSet: {
            iteration: 1,
            questions: [
              researchQuestionFixture({
                id: "q-docs",
                text: "How do I configure actionlint?",
                researchMode: "official-docs",
                researchModeRationale: "Usage syntax should come from official docs.",
                providerHints: ["exa"],
                searchQueries: ["actionlint usage documentation"],
              }),
              researchQuestionFixture({
                id: "q-recency",
                text: "Are people reporting recent setup-nub CI issues?",
                researchMode: "recency-social",
                researchModeRationale: "Recent community reports need social/recency providers.",
                providerHints: ["grok", "copilot-last30days"],
                searchQueries: ["recent setup-nub GitHub Actions issues"],
              }),
              researchQuestionFixture({
                id: "q-choice",
                text: "Which linting framework should this repo choose?",
                researchMode: "deep-research",
                researchModeRationale: "Framework choice needs tradeoff research.",
                providerHints: [],
                searchQueries: ["TypeScript lint framework Oxc ESLint Biome comparison"],
              }),
              researchQuestionFixture({
                id: "q-local",
                text: "Does this repository already have a CI workflow?",
                researchMode: "local-only",
                researchModeRationale: "Repository evidence only.",
                providerHints: [],
                searchQueries: [],
              }),
            ],
          },
        },
      },
      currentPlan: {
        id: "deep-research-test",
        objective: "Research verification choices",
        templateId: "deep-research",
        maxReplans: 0,
        nodes: [seedNode],
      },
      payloads: new Map(),
      completedNodeIds: new Set([seedNode.id]),
    });

    const providerNodes = (expansion ?? []).filter(
      (node) => node.input?.deepResearchStep === "provider-research",
    );
    expect(
      providerNodes.map((node) => ({
        id: node.id,
        questionIds: ((node.input?.questions ?? []) as Array<{ id: string }>).map(
          (question) => question.id,
        ),
        queryCount: ((node.input?.queries ?? []) as string[]).length,
      })),
    ).toEqual([
      {
        id: "deep-research-grok-1",
        questionIds: ["q-recency", "q-choice"],
        queryCount: 2,
      },
      {
        id: "deep-research-exa-1",
        questionIds: ["q-docs", "q-choice"],
        queryCount: 2,
      },
      {
        id: "deep-research-copilot-last30days-1",
        questionIds: ["q-recency", "q-choice"],
        queryCount: 2,
      },
    ]);
    expect(
      providerNodes
        .flatMap((node) => node.input?.questions as Array<{ id: string }>)
        .map((question) => question.id),
    ).not.toContain("q-local");
    expect((expansion ?? []).find((node) => node.id === "deep-research-assess-1")).toMatchObject({
      dependsOn: [
        "deep-research-grok-1",
        "deep-research-exa-1",
        "deep-research-copilot-last30days-1",
      ],
    });
  });

  it("keeps provider-hint and all-provider fallback routing for older questions without research modes", async () => {
    const expander = createDeepResearchDynamicExpander();
    const seedNode = buildQuestionNodeFixture();
    const expansion = await expander({
      node: seedNode,
      result: {
        nodeId: seedNode.id,
        status: "passed",
        output: "Generated legacy questions.",
        payload: {
          deepResearchQuestionSet: {
            iteration: 1,
            questions: [
              researchQuestionFixture({
                id: "q-hinted",
                text: "What does Exa know?",
                researchMode: undefined,
                researchModeRationale: undefined,
                providerHints: ["exa"],
                searchQueries: ["exa-only lookup"],
              }),
              researchQuestionFixture({
                id: "q-unhinted",
                text: "What broad research should run?",
                researchMode: undefined,
                researchModeRationale: undefined,
                providerHints: [],
                searchQueries: ["broad lookup"],
              }),
            ],
          },
        },
      },
      currentPlan: {
        id: "deep-research-test",
        objective: "Research verification choices",
        templateId: "deep-research",
        maxReplans: 0,
        nodes: [seedNode],
      },
      payloads: new Map(),
      completedNodeIds: new Set([seedNode.id]),
    });

    const providerNodes = (expansion ?? []).filter(
      (node) => node.input?.deepResearchStep === "provider-research",
    );
    expect(
      providerNodes.map((node) => ({
        id: node.id,
        questionIds: ((node.input?.questions ?? []) as Array<{ id: string }>).map(
          (question) => question.id,
        ),
      })),
    ).toEqual([
      {
        id: "deep-research-grok-1",
        questionIds: ["q-unhinted"],
      },
      {
        id: "deep-research-exa-1",
        questionIds: ["q-hinted", "q-unhinted"],
      },
      {
        id: "deep-research-copilot-last30days-1",
        questionIds: ["q-unhinted"],
      },
    ]);
  });

  it("publishes actual provider prompts before provider research nodes run", async () => {
    const registry = createDeepResearchHarnessRegistry();
    const adapter = registry.get(WorkflowHarnessKind.RESEARCH)!;
    const context = emptyExecutionContext();
    const questions = [
      {
        id: "q1",
        text: "What CI workflow should this repository use?",
        rationale: "Need CI evidence.",
        researchMode: "web-lookup",
        researchModeRationale: "Fixture question uses lightweight web lookup.",
        priority: 1,
        providerHints: ["grok", "copilot-last30days", "exa"],
        searchQueries: ["Node TypeScript GitHub Actions CI"],
        completionCriteria: ["Find CI guidance."],
        status: "pending",
        dependencies: [],
      },
    ];

    const copilotExecution = await adapter.prepareExecution?.(
      providerNodeFixture("copilot-last30days", questions),
      context,
    );
    const grokExecution = await adapter.prepareExecution?.(
      providerNodeFixture("grok", questions),
      context,
    );
    const exaExecution = await adapter.prepareExecution?.(
      providerNodeFixture("exa", questions),
      context,
    );

    expect(copilotExecution?.calls?.[0]).toMatchObject({
      executor: "copilot-last30days",
      operation: "search",
      mode: "research",
      model: "claude-sonnet-5",
      prompt: expect.stringContaining("/last30days"),
    });
    expect(copilotExecution?.calls?.[0]?.prompt).toContain(
      "What CI workflow should this repository use?",
    );
    expect(grokExecution?.calls?.[0]).toMatchObject({
      executor: "grok",
      operation: "search",
      mode: "research",
      model: "grok-default",
      prompt: expect.stringContaining("Use x_search for each query below"),
    });
    expect(grokExecution?.calls?.[0]?.prompt).toContain("Node TypeScript GitHub Actions CI");
    expect(exaExecution?.calls?.[0]).toMatchObject({
      executor: "exa",
      operation: "search",
      mode: "research",
      model: "claude-sonnet-5",
      prompt: expect.stringContaining("Node TypeScript GitHub Actions CI"),
    });
  });

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
        return [
          {
            provider: name,
            questionId: args.questions[0]?.id ?? "unknown",
            query: args.queries[0] ?? "",
            url: `https://example.com/${name}`,
            title: `${name} result`,
            excerpt: `${name} excerpt`,
            content: `${name} content`,
            sourceQuality: "primary",
            provenance:
              name === "grok" ? "grok cli with x_search" : "exa mcp web_search_exa/web_fetch_exa",
          },
        ];
      },
    });

    const harnesses = createDeepResearchHarnessRegistry({
      baml: {
        async GenerateResearchQuestions(_prompt, _priorState, config) {
          bamlCalls.push(`questions:${config.maxIterations}`);
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "What patterns make agent workflows durable?",
                rationale: "Core objective coverage.",
                researchMode: "deep-research",
                researchModeRationale: "Fixture question exercises all configured providers.",
                priority: 1,
                providerHints: ["exa", "grok"],
                searchQueries: ["durable agent workflows"],
                completionCriteria: ["Find concrete patterns."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          bamlCalls.push(`assess:${evidence.length}`);
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 0.9,
                evidenceQuality: "high",
                contradictions: [],
                gaps: [],
              },
            ],
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
    expect(providerCalls).toEqual(["exa:durable agent workflows", "grok:durable agent workflows"]);
    expect(bamlCalls).toEqual(["questions:2", "assess:2", "report:2"]);
    expect(state.currentPlan.nodes.map((node) => node.id)).toEqual([
      "deep-research-questions-1",
      "deep-research-exa-1",
      "deep-research-grok-1",
      "deep-research-assess-1",
      "deep-research-report",
    ]);
    expect(state.currentPlan.nodes.find((node) => node.id === "deep-research-exa-1")).toMatchObject(
      {
        model: "claude-sonnet-5",
        modelRationale:
          "Exa provider research uses Sonnet for source-query execution and synthesis.",
      },
    );
    expect(
      state.currentPlan.nodes.find((node) => node.id === "deep-research-grok-1"),
    ).toMatchObject({
      model: "grok-default",
      modelRationale: "Grok provider research uses the configured Grok CLI default model.",
    });
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-report")?.payload,
    ).toMatchObject({
      deepResearchReport: {
        objective: "Research durable agent workflows",
        methodology: expect.stringContaining("Collected 2 normalized evidence item(s)"),
        evidenceMatrix: [
          expect.objectContaining({ questionId: "q1", evidenceId: "exa-1-1" }),
          expect.objectContaining({ questionId: "q1", evidenceId: "grok-1-1" }),
        ],
        sources: [
          expect.objectContaining({
            id: "exa-1-1",
            provider: "exa",
            url: "https://example.com/exa",
          }),
          expect.objectContaining({
            id: "grok-1-1",
            provider: "grok",
            url: "https://example.com/grok",
          }),
        ],
        markdown: expect.stringContaining("# Deep Research Report"),
      },
    });
  });

  it("keeps namespaced embedded research runs from mixing evidence", async () => {
    const provider: DeepResearchProviderClient = {
      async search(args) {
        const prefix = args.objective.includes("lint") ? "lint" : "hooks";
        return [
          {
            provider: "exa",
            questionId: args.questions[0]?.id ?? `${prefix}-q1`,
            query: args.queries[0] ?? "",
            url: `https://example.com/${prefix}`,
            title: `${prefix} guidance`,
            excerpt: `Use the maintained ${prefix} tool.`,
            content: `Use the maintained ${prefix} tool for verification.`,
            sourceQuality: "primary",
            provenance: "exa mcp web_search_exa",
          },
        ];
      },
    };
    const compiled: Array<{ objective: string; evidenceIds: string[] }> = [];
    const harnesses = createDeepResearchHarnessRegistry({
      providers: { exa: provider },
      baml: {
        async GenerateResearchQuestions(prompt) {
          const prefix = String(prompt).includes("lint") ? "lint" : "hooks";
          return {
            iteration: 1,
            questions: [
              {
                id: `${prefix}-q1`,
                text: `Which ${prefix} verification tool should this gap use?`,
                rationale: "Need tool guidance.",
                researchMode: "web-lookup",
                researchModeRationale: "Fixture question uses lightweight web lookup.",
                priority: 1,
                providerHints: ["exa"],
                searchQueries: [`${prefix} verification tool guidance`],
                completionCriteria: ["Find tool guidance."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(questionSet, evidence, priorState) {
          expect(evidence.map((item) => item.questionId)).toEqual([questionSet.questions[0]?.id]);
          expect(
            priorState.evidence.every((item) =>
              item.questionId.startsWith(questionSet.questions[0]?.id.split("-")[0] ?? ""),
            ),
          ).toBe(true);
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: questionSet.questions[0]?.id ?? "q1",
                coverageScore: 0.9,
                evidenceQuality: "high",
                contradictions: [],
                gaps: [],
              },
            ],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "coverage sufficient",
          };
        },
        async CompileDeepResearchReport(prompt, finalState) {
          compiled.push({
            objective: prompt,
            evidenceIds: finalState.evidence.map((item) => item.id),
          });
          return { markdown: "# Deep Research Report\n\nUse the maintained tool." };
        },
      },
    });
    const lintSeed = materializeWorkflowPlan("deep-research", {
      objective: "Research lint verification candidate",
      deepResearchRunId: "verification-research-lint",
      providers: ["exa"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
    }).nodes[0]!;
    const hooksSeed = materializeWorkflowPlan("deep-research", {
      objective: "Research hooks verification candidate",
      deepResearchRunId: "verification-research-hooks",
      providers: ["exa"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
    }).nodes[0]!;

    const state = await runMacroWorkflow(
      {
        id: "embedded-deep-research",
        objective: "Research verification candidates",
        templateId: "verification-optimizer",
        maxReplans: 0,
        nodes: [lintSeed, hooksSeed],
      },
      {
        harnesses,
        expandAfterNode: createDeepResearchDynamicExpander(),
      },
    );

    expect(state.status).toBe("passed");
    expect(state.currentPlan.nodes.map((node) => node.id)).toEqual([
      "verification-research-lint-questions-1",
      "verification-research-hooks-questions-1",
      "verification-research-lint-exa-1",
      "verification-research-lint-assess-1",
      "verification-research-hooks-exa-1",
      "verification-research-hooks-assess-1",
      "verification-research-lint-report",
      "verification-research-hooks-report",
    ]);
    expect(compiled).toEqual([
      { objective: "Research lint verification candidate", evidenceIds: ["exa-1-1"] },
      { objective: "Research hooks verification candidate", evidenceIds: ["exa-1-1"] },
    ]);
    expect(
      state.nodeResults.find((result) => result.nodeId === "verification-research-lint-report")
        ?.payload,
    ).toMatchObject({
      deepResearchRunId: "verification-research-lint",
      deepResearchReport: {
        objective: "Research lint verification candidate",
        sources: [expect.objectContaining({ url: "https://example.com/lint" })],
      },
    });
    expect(
      state.nodeResults.find((result) => result.nodeId === "verification-research-hooks-report")
        ?.payload,
    ).toMatchObject({
      deepResearchRunId: "verification-research-hooks",
      deepResearchReport: {
        objective: "Research hooks verification candidate",
        sources: [expect.objectContaining({ url: "https://example.com/hooks" })],
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
            questions: [
              {
                id: "q1",
                text: "What exists?",
                rationale: "Need sources.",
                researchMode: "deep-research",
                researchModeRationale:
                  "Fixture question exercises the configured accepted provider.",
                priority: 1,
                providerHints: ["tavily"],
                searchQueries: ["agent research"],
                completionCriteria: ["Find sources."],
                status: "pending",
                dependencies: [],
              },
            ],
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
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-tavily-1"),
    ).toMatchObject({
      status: "failed",
      error:
        "Deep research provider tavily is accepted but not implemented/configured for this MVP.",
    });
  });

  it("lets the Grok CLI use its configured default model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deep-research-grok-default-"));
    const argsPath = join(dir, "args.txt");
    const commandPath = join(dir, "grok-default.sh");
    await writeFile(
      commandPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > "${argsPath}"`,
        "printf '%s\\n' 'Grok default model research output.'",
      ].join("\n"),
      "utf8",
    );
    await chmod(commandPath, 0o755);

    const harnesses = createDeepResearchHarnessRegistry({
      grok: { command: commandPath },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "What does Grok find?",
                rationale: "Need Grok evidence.",
                researchMode: "recency-social",
                researchModeRationale: "Fixture question exercises Grok recency routing.",
                priority: 1,
                providerHints: ["grok"],
                searchQueries: ["grok default model research"],
                completionCriteria: ["Find one result."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          expect(evidence[0]).toMatchObject({
            provider: "grok",
            content: "Grok default model research output.",
          });
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 1,
                evidenceQuality: "medium",
                contradictions: [],
                gaps: [],
              },
            ],
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
      objective: "Research with Grok default model",
      providers: ["grok"],
      maxIterations: 1,
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
    const args = await readFile(argsPath, "utf8");
    expect(args).toContain("-p\n");
    expect(args).toContain("--output-format\nplain\n");
    expect(args).not.toContain("-m\n");
    expect(args).not.toContain("grok-build");
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
                researchMode: "recency-social",
                researchModeRationale: "Fixture question exercises last30days recency routing.",
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
                researchMode: "recency-social",
                researchModeRationale: "Fixture question exercises last30days recency routing.",
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
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 1,
                evidenceQuality: "community",
                contradictions: [],
                gaps: [],
              },
            ],
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
    expect(state.currentPlan.nodes.map((node) => node.id)).toContain(
      "deep-research-copilot-last30days-1",
    );
    expect(
      state.currentPlan.nodes.find((node) => node.id === "deep-research-copilot-last30days-1"),
    ).toMatchObject({
      model: "claude-sonnet-5",
      modelRationale:
        "Copilot last30days provider research uses Sonnet for recent-source synthesis.",
    });
    expect(copilotCalls).toEqual([
      expect.objectContaining({
        mode: "research",
        model: "claude-sonnet-5",
        maxToolCalls: 60,
        operation: "deep-research-copilot-last30days-1",
        capabilityScope: {
          kind: "skill",
          skillName: "last30days",
          skillDirectories: [skillsRoot],
          disabledSkills: ["other-skill"],
        },
      }),
    ]);
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
            questions: [
              {
                id: "q1",
                text: "What are developers saying?",
                rationale: "Need recent community evidence.",
                researchMode: "recency-social",
                researchModeRationale: "Fixture question exercises last30days recency routing.",
                priority: 1,
                providerHints: ["copilot-last30days"],
                searchQueries: ["agent workflow reliability"],
                completionCriteria: ["Find recent discussion."],
                status: "pending",
                dependencies: [],
              },
            ],
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
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-copilot-last30days-1")
        ?.error,
    ).toContain("Install it with `nubx skills add mvanhorn/last30days-skill -g`.");
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
            questions: [
              {
                id: "q1",
                text: "What makes agent workflows durable?",
                rationale: "Need durable workflow evidence.",
                researchMode: "web-lookup",
                researchModeRationale: "Fixture question uses lightweight web lookup.",
                priority: 1,
                providerHints: ["exa"],
                searchQueries: ["durable agent workflows"],
                completionCriteria: ["Find one cited source."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(_questionSet, _evidence, _priorState) {
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 0.7,
                evidenceQuality: "medium",
                contradictions: [],
                gaps: ["Need more production case studies."],
              },
            ],
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
            return [
              {
                provider: "exa",
                questionId: "q1",
                query: "durable agent workflows",
                url: "https://example.com/durable-agents",
                title: "Durable Agents",
                excerpt: "Durable agents persist state, retry work, and resume after failures.",
                content: "Long source content that should not be required for fallback markdown.",
                sourceQuality: "primary",
                provenance: "exa mcp web_search_exa",
              },
            ];
          },
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
      outputDir,
    });

    const reportResult = state.nodeResults.find(
      (result) => result.nodeId === "deep-research-report",
    );
    await writeMacroWorkflowArtifacts({ outputDir, state });
    const markdown = await readFile(join(outputDir, "DeepResearchReport.md"), "utf8");

    expect(state.status).toBe("failed");
    expect(reportResult).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Missing required field: markdown"),
      payload: {
        deepResearchReport: {
          markdown: expect.stringContaining("# Deep Research Report"),
          sources: [
            {
              id: "exa-1-1",
              provider: "exa",
              url: "https://example.com/durable-agents",
              title: "Durable Agents",
              quality: "primary",
            },
          ],
        },
      },
    });
    expect(reportResult?.output).toContain("BAML report compilation failed");
    expect(markdown).toContain("Durable agents persist state");
    expect(markdown).toContain("https://example.com/durable-agents");
    const payload = JSON.parse(
      await readFile(join(outputDir, "deep-research-report.payload.json"), "utf8"),
    ) as {
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
            questions: [
              {
                id: "q1",
                text: "What makes agent workflows durable?",
                rationale: "Need durable workflow evidence.",
                researchMode: "web-lookup",
                researchModeRationale: "Fixture question uses lightweight web lookup.",
                priority: 1,
                providerHints: ["exa"],
                searchQueries: ["durable agent workflows"],
                completionCriteria: ["Find one cited source."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration() {
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 1,
                evidenceQuality: "high",
                contradictions: [],
                gaps: [],
              },
            ],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "complete",
          };
        },
        async CompileDeepResearchReport() {
          return {
            markdown:
              "{objective: Research durable agent workflows, methodology: old structured response without markdown}",
          };
        },
      },
      providers: {
        exa: {
          async search() {
            return [
              {
                provider: "exa",
                questionId: "q1",
                query: "durable agent workflows",
                title: "Durable Agents",
                excerpt: "Durable agents persist state.",
                sourceQuality: "primary",
                provenance: "exa mcp web_search_exa",
              },
            ];
          },
        },
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("failed");
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-report"),
    ).toMatchObject({
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
            results: [
              {
                url: "https://example.com/exa",
                title: "Exa result",
                text: "Search excerpt",
              },
            ],
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
            questions: [
              {
                id: "q1",
                text: "What does Exa find?",
                rationale: "Need web evidence.",
                researchMode: "web-lookup",
                researchModeRationale: "Fixture question uses lightweight web lookup.",
                priority: 1,
                providerHints: ["exa"],
                searchQueries: ["exa deep research"],
                completionCriteria: ["Find one source."],
                status: "pending",
                dependencies: [],
              },
            ],
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
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 1,
                evidenceQuality: "high",
                contradictions: [],
                gaps: [],
              },
            ],
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
            throw new Error(
              "web_search_exa error (403): The following requested domains are not available: x.com. Remove them from includeDomains and try again.",
            );
          }
          return {
            results: [
              {
                url: "https://example.com/typescript-linter",
                title: "TypeScript linter comparison",
                text: "Biome, oxlint, and ESLint have different performance and completeness tradeoffs.",
              },
            ],
          };
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "Which TypeScript linter is fastest and most complete?",
                rationale: "Need current linter evidence.",
                researchMode: "deep-research",
                researchModeRationale:
                  "Fixture question exercises partial provider failure handling.",
                priority: 1,
                providerHints: ["exa"],
                searchQueries: ["site:x.com TypeScript linter Biome Oxlint ESLint"],
                completionCriteria: ["Find one source."],
                status: "pending",
                dependencies: [],
              },
            ],
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
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 1,
                evidenceQuality: "medium",
                contradictions: [],
                gaps: [],
              },
            ],
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
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-exa-1")?.output,
    ).toContain("after 1 retry");
  });

  it("continues assessment when one provider in a multi-provider iteration exhausts retries", async () => {
    const assessmentEvidenceCounts: number[] = [];
    const harnesses = createDeepResearchHarnessRegistry({
      providers: {
        exa: {
          async search(args) {
            return [
              {
                provider: "exa",
                questionId: args.questions[0]?.id ?? "q1",
                query: args.queries[0] ?? "ci workflow",
                url: "https://example.com/ci",
                title: "CI guidance",
                excerpt: "Run typecheck, tests, code generation, and build in CI.",
                sourceQuality: "primary",
                provenance: "exa mcp web_search_exa",
              },
            ];
          },
        },
        grok: {
          async search() {
            throw new Error("grok cli failed");
          },
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "What CI workflow should this repository use?",
                rationale: "Need CI evidence.",
                researchMode: "deep-research",
                researchModeRationale:
                  "Fixture question exercises fan-in when only one provider returns evidence.",
                priority: 1,
                providerHints: ["exa", "grok"],
                searchQueries: ["Node TypeScript GitHub Actions CI"],
                completionCriteria: ["Find CI guidance."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          assessmentEvidenceCounts.push(evidence.length);
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 0.8,
                evidenceQuality: "medium",
                contradictions: [],
                gaps: ["Grok provider failed."],
              },
            ],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "enough evidence from remaining providers",
          };
        },
        async CompileDeepResearchReport() {
          return {
            markdown: "# Deep Research Report\n\nUse CI guidance from remaining providers.",
          };
        },
      },
    });
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research CI verification",
      providers: ["exa", "grok"],
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
    expect(assessmentEvidenceCounts).toEqual([1]);
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-grok-1"),
    ).toMatchObject({
      status: "passed",
      output: expect.stringContaining("grok failed after 1 retry"),
      payload: {
        deepResearchEvidence: [],
        deepResearchProviderFailures: [
          {
            provider: "grok",
            iteration: 1,
            retryCount: 1,
            message: "grok cli failed",
          },
        ],
      },
    });
    expect(state.currentPlan.nodes.map((node) => node.id)).toContain("deep-research-assess-1");
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-assess-1"),
    ).toMatchObject({
      status: "passed",
      output: expect.stringContaining("Research iteration 1 is sufficient"),
    });
  });

  it("continues when only one of grok, copilot-last30days, and exa returns evidence", async () => {
    const assessedEvidenceProviders: string[][] = [];
    const failingProvider: DeepResearchProviderClient = {
      async search(args) {
        throw new Error(`${args.provider} failed`);
      },
    };
    const harnesses = createDeepResearchHarnessRegistry({
      providers: {
        grok: failingProvider,
        "copilot-last30days": failingProvider,
        exa: {
          async search(args) {
            return [
              {
                provider: "exa",
                questionId: args.questions[0]?.id ?? "q1",
                query: args.queries[0] ?? "ci workflow",
                url: "https://example.com/ci",
                title: "CI guidance",
                excerpt: "Run verification in CI.",
                sourceQuality: "primary",
                provenance: "exa mcp web_search_exa",
              },
            ];
          },
        },
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "What CI workflow should this repository use?",
                rationale: "Need CI evidence.",
                researchMode: "deep-research",
                researchModeRationale:
                  "Fixture question exercises all configured provider failures.",
                priority: 1,
                providerHints: ["grok", "copilot-last30days", "exa"],
                searchQueries: ["Node TypeScript GitHub Actions CI"],
                completionCriteria: ["Find CI guidance."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration(_questionSet, evidence) {
          assessedEvidenceProviders.push(evidence.map((item) => item.provider));
          return {
            iteration: 1,
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 0.75,
                evidenceQuality: "medium",
                contradictions: [],
                gaps: ["Two providers failed."],
              },
            ],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "one provider returned enough evidence",
          };
        },
        async CompileDeepResearchReport() {
          return { markdown: "# Deep Research Report\n\nUse the surviving provider evidence." };
        },
      },
    });
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research CI verification",
      providers: ["grok", "copilot-last30days", "exa"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
      providerRetryAttempts: 0,
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("passed");
    expect(assessedEvidenceProviders).toEqual([["exa"]]);
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-grok-1"),
    ).toMatchObject({
      status: "passed",
      payload: {
        deepResearchEvidence: [],
        deepResearchProviderFailures: [expect.objectContaining({ provider: "grok" })],
      },
    });
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-copilot-last30days-1"),
    ).toMatchObject({
      status: "passed",
      payload: {
        deepResearchEvidence: [],
        deepResearchProviderFailures: [expect.objectContaining({ provider: "copilot-last30days" })],
      },
    });
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-assess-1"),
    ).toMatchObject({
      status: "passed",
      output: expect.stringContaining("Research iteration 1 is sufficient"),
    });
  });

  it("fails assessment clearly when every provider in an iteration fails", async () => {
    const failingProvider: DeepResearchProviderClient = {
      async search(args) {
        throw new Error(`${args.provider} unavailable`);
      },
    };
    const harnesses = createDeepResearchHarnessRegistry({
      providers: {
        exa: failingProvider,
        grok: failingProvider,
      },
      baml: {
        async GenerateResearchQuestions() {
          return {
            iteration: 1,
            questions: [
              {
                id: "q1",
                text: "What CI workflow should this repository use?",
                rationale: "Need CI evidence.",
                researchMode: "web-lookup",
                researchModeRationale: "Fixture question uses lightweight web lookup.",
                priority: 1,
                providerHints: ["exa", "grok"],
                searchQueries: ["Node TypeScript GitHub Actions CI"],
                completionCriteria: ["Find CI guidance."],
                status: "pending",
                dependencies: [],
              },
            ],
          };
        },
        async AssessResearchIteration() {
          throw new Error("assessment should not run without evidence");
        },
        async CompileDeepResearchReport() {
          throw new Error("report should not run without evidence");
        },
      },
    });
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research CI verification",
      providers: ["exa", "grok"],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
      providerRetryAttempts: 0,
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createDeepResearchDynamicExpander(),
    });

    expect(state.status).toBe("failed");
    expect(
      state.nodeResults.find((result) => result.nodeId === "deep-research-assess-1"),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("All provider research failed for iteration 1"),
    });
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
            questions: [
              {
                id: "q1",
                text: "What makes agents durable?",
                rationale: "Need cited source.",
                researchMode: "web-lookup",
                researchModeRationale: "Fixture question uses lightweight web lookup.",
                priority: 1,
                providerHints: ["exa"],
                searchQueries: ["durable agent workflows"],
                completionCriteria: ["Find one source."],
                status: "pending",
                dependencies: [],
              },
            ],
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
            questionCoverage: [
              {
                questionId: "q1",
                coverageScore: 1,
                evidenceQuality: "high",
                contradictions: [],
                gaps: [],
              },
            ],
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
    const callTool = vi.fn(
      async ({ arguments: input }: { arguments?: Record<string, unknown> }) => ({
        structuredContent: {
          results: [{ url: "https://example.com", title: "Result", text: String(input?.query) }],
        },
      }),
    );
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
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "exa",
        url: expect.stringContaining("exa-secret"),
      }),
    );
    await expect(
      connection.client?.web_search_exa({ query: "agent research", numResults: 2 }),
    ).resolves.toMatchObject({ results: [{ title: "Result" }] });
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
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: [{ url: "https://example.com/exa", title: "Exa" }] }),
        },
      ],
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

    await expect(
      connection.client?.web_search_exa({ query: "agent research", numResults: 2 }),
    ).resolves.toMatchObject({ results: [{ title: "Exa" }] });
    expect(callTool).toHaveBeenCalledWith({
      name: "web_search_exa",
      arguments: { query: "agent research", numResults: 2 },
    });

    await connection.close();
  });
});

function providerNodeFixture(
  provider: string,
  questions: WorkflowNodePayload[],
): RuntimeWorkflowNode {
  return {
    id: `deep-research-${provider}-1`,
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: `Research with ${provider}`,
    prompt: `Run ${provider} research for deep research iteration 1.`,
    input: {
      deepResearchStep: "provider-research",
      provider,
      iteration: 1,
      objective: "Research CI verification",
      questions,
      queries: ["Node TypeScript GitHub Actions CI"],
      maxResultsPerQuestion: 5,
      questionNodeId: "deep-research-questions-1",
      config: {
        providers: ["grok", "copilot-last30days", "exa"],
        maxIterations: 1,
        questionsPerIteration: 1,
        maxResultsPerQuestion: 5,
        providerRetryAttempts: 1,
        visualize: false,
      },
    },
    dependsOn: ["deep-research-questions-1"],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildQuestionNodeFixture(): RuntimeWorkflowNode {
  return {
    id: "deep-research-questions-1",
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: "Generate research questions",
    prompt: "Generate the first research question set for the objective.",
    input: {
      deepResearchStep: "generate-questions",
      iteration: 1,
      config: {
        providers: ["grok", "exa", "copilot-last30days"],
        maxIterations: 1,
        questionsPerIteration: 4,
        maxResultsPerQuestion: 2,
        providerRetryAttempts: 1,
        visualize: false,
      },
    },
    dependsOn: [],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function researchQuestionFixture(overrides: WorkflowNodePayload = {}): WorkflowNodePayload {
  return {
    id: "q1",
    text: "What should be researched?",
    rationale: "Need evidence.",
    researchMode: "web-lookup",
    researchModeRationale: "Fixture question uses lightweight web lookup.",
    priority: 1,
    providerHints: ["exa"],
    searchQueries: ["verification research"],
    completionCriteria: ["Find evidence."],
    status: "pending",
    dependencies: [],
    ...overrides,
  };
}

function emptyExecutionContext(): WorkflowExecutionContext {
  return {
    payloads: new Map(),
    artifacts: new Map(),
    objective: "Research CI verification",
  };
}
