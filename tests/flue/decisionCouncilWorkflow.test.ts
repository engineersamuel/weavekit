import type { McpServerConnection, ToolDefinition } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import type { CritiqueNormalizer, JudgeReducer } from "../../src/decision-council/bamlAdapters.js";
import type { PersonaWorker } from "../../src/decision-council/personaWorker.js";
import { createConfiguredDecisionCouncilWorkflow } from "../../src/flue/decisionCouncilWorkflow.js";

const personaWorker: PersonaWorker = {
  async runPersona({ persona, brief }) {
    return {
      personaId: persona.id,
      text: `${persona.name} critique for round ${brief.roundNumber}`,
      transcript: [`assistant: ${persona.name}`],
      metadata: { model: "fake" },
    };
  },
};

const normalizer: CritiqueNormalizer = {
  async normalizeCritique(raw) {
    return {
      personaId: raw.personaId,
      overallSummary: `${raw.personaId} summary`,
      summary: raw.text,
      claims: [],
      risks: [],
      questions: [],
      recommendations: [],
    };
  },
};

const judge: JudgeReducer = {
  async assessRound() {
    return {
      roundNumber: 1,
      consensus: "Stop",
      disagreements: [],
      confidence: 0.8,
      convergence: 0.9,
      shouldContinue: false,
      diminishingReturns: false,
      nextRoundBrief: "Stop.",
    };
  },
  async createFinalReport() {
    return {
      recommendation: "Use Flue.",
      rationale: ["MCP tools are configured by application code."],
      strongestObjections: [],
      unresolvedQuestions: [],
      confidence: 0.8,
      convergence: 0.9,
      nextExperiment: "Run a live MCP smoke test.",
      finalReportMarkdown: "# Decision Council Report\n\nUse Flue.",
      failedPersonas: [],
    };
  },
};

describe("createConfiguredDecisionCouncilWorkflow", () => {
  it("connects enabled MCP specs, creates a workflow, and exposes cleanup", async () => {
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async (name: string) => ({
      name,
      tools: [{ name: name === "context7" ? "mcp__context7__query_docs" : `mcp__${name}__search` } as ToolDefinition],
      close,
    }) satisfies McpServerConnection);

    const result = await createConfiguredDecisionCouncilWorkflow(
      { personaWorker, normalizer, judge },
      {
        env: { EXA_API_KEY: "exa-secret", CONTEXT7_API_KEY: "ctx-key" },
        connectMcpServer: connect,
        flueModel: "github-copilot/gpt-4o",
      },
    );

    expect(connect).toHaveBeenCalledWith("exa", expect.objectContaining({ url: expect.stringContaining("exa-secret") }));
    expect(connect).toHaveBeenCalledWith("EngHub", expect.objectContaining({ url: "https://mcp.eng.ms" }));
    expect(connect).toHaveBeenCalledWith("context7", expect.objectContaining({ headers: { CONTEXT7_API_KEY: "ctx-key" } }));
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "mcp__exa__search",
      "mcp__EngHub__search",
      "mcp__context7__query_docs",
    ]);
    expect(result.workflow).toBeDefined();

    await result.close();
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("can opt into local Baton without enabling unsupported stdio MCPs", async () => {
    const connect = vi.fn(async (name: string) => ({
      name,
      tools: [],
      close: async () => undefined,
    }) satisfies McpServerConnection);

    await createConfiguredDecisionCouncilWorkflow(
      { personaWorker, normalizer, judge },
      { env: {}, includeLocalBaton: true, connectMcpServer: connect },
    );

    expect(connect.mock.calls.map(([name]) => name)).toEqual(["EngHub", "baton"]);
    expect(connect.mock.calls.map(([name]) => name)).not.toContain("awesome-copilot");
  });
});
