import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { claudeHeadlessAdapter } from "../../../src/rlm-poc/trellage/adapters/claude.js";
import {
  MAX_TOOL_USE_EVIDENCE_ENTRIES,
  MAX_TOOL_USE_EVIDENCE_STRING_LENGTH,
} from "../../../src/rlm-poc/trellage/adapters/contracts.js";
import { copilotHeadlessAdapter } from "../../../src/rlm-poc/trellage/adapters/copilot.js";
import { headlessAdapterFor } from "../../../src/rlm-poc/trellage/adapters/index.js";
import { ompCopilotHeadlessAdapter } from "../../../src/rlm-poc/trellage/adapters/omp.js";
import {
  TrellageHarness,
  TrellageHeadlessTerminal,
  TrellageMode,
  type TrellageProfile,
} from "../../../src/rlm-poc/trellage/contracts.js";

const FIXTURE_ROOT = new URL("./fixtures/headless/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

describe("headless launcher adapters", () => {
  const ompCopilotProfile: TrellageProfile = {
    harness: TrellageHarness.OhMyPi,
    mode: TrellageMode.Native,
    launcher: "omp",
    name: "copilot",
    description: "OMP with native Copilot authentication.",
    sandbox: false,
  };

  it("normalizes a Claude stream-json terminal result", async () => {
    const result = claudeHeadlessAdapter.parse({
      stdout: await fixture("claude-completed.jsonl"),
      stderr: "",
    });

    expect(result).toMatchObject({
      terminal: TrellageHeadlessTerminal.Completed,
      finalText: "Implemented the requested change.",
      sessionId: "claude-session-1",
      reportedSuccess: true,
      durationMs: 1234,
      costUsd: 0.01,
      turns: 2,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 5,
      },
      toolUses: [
        { name: "Skill", selector: "frontend-design", count: 2 },
        { name: "Agent", selector: "member", count: 1 },
        { name: "Bash", count: 1 },
      ],
      toolUsesTruncated: false,
    });
    expect(JSON.stringify(result.toolUses)).not.toMatch(/prompt|description|secret command/u);
    expect(result.tokenUsage).not.toHaveProperty("totalTokens");
  });

  it("bounds Claude tool evidence entries and strings", () => {
    const longSelector = "s".repeat(MAX_TOOL_USE_EVIDENCE_STRING_LENGTH + 1);
    const toolUses = [
      {
        type: "tool_use",
        name: "Skill",
        input: { skill: longSelector },
      },
      ...Array.from({ length: MAX_TOOL_USE_EVIDENCE_ENTRIES }, (_, index) => ({
        type: "tool_use",
        name: `Tool-${String(index)}`,
        input: { prompt: `private-${String(index)}` },
      })),
    ];
    const result = claudeHeadlessAdapter.parse({
      stdout: [
        JSON.stringify({ type: "assistant", message: { content: toolUses } }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
        }),
      ].join("\n"),
      stderr: "",
    });

    expect(result.toolUses).toHaveLength(MAX_TOOL_USE_EVIDENCE_ENTRIES);
    expect(result.toolUses?.[0]?.selector).toHaveLength(MAX_TOOL_USE_EVIDENCE_STRING_LENGTH);
    expect(result.toolUsesTruncated).toBe(true);
  });

  it("normalizes paired Copilot task-complete and result events", async () => {
    const result = copilotHeadlessAdapter.parse({
      stdout: await fixture("copilot-completed.jsonl"),
      stderr: "",
    });

    expect(result).toMatchObject({
      terminal: TrellageHeadlessTerminal.Completed,
      finalText: "Implemented the requested change.",
      sessionId: "copilot-session-1",
      reportedSuccess: true,
      changedFiles: ["src/example.ts"],
      durationMs: 321,
      premiumRequests: 1,
      tokenUsage: {
        inputTokens: 75,
        outputTokens: 25,
        cachedInputTokens: 10,
        totalTokens: 100,
      },
    });
  });

  it("skips malformed JSONL lines but fails closed without Copilot's full terminal contract", () => {
    const result = copilotHeadlessAdapter.parse({
      stdout: '{"type":"session.task_complete","data":{"summary":"done"}}\nnot-json\n',
      stderr: "",
    });

    expect(result.terminal).toBe(TrellageHeadlessTerminal.Malformed);
    expect(result.parseWarnings).toEqual(
      expect.arrayContaining(["line 2: invalid JSON", "missing Copilot result event"]),
    );
  });

  it("preserves a question envelope from the last assistant message", () => {
    const envelope =
      '<trellage_questions version="1">{"questions":[{"id":"color","text":"What color?"}]}</trellage_questions>';
    const result = copilotHeadlessAdapter.parse({
      stdout: [
        JSON.stringify({ type: "assistant.message", data: { content: envelope } }),
        JSON.stringify({
          type: "assistant.message",
          data: { content: "No parent-grounded answer arrived." },
        }),
        JSON.stringify({
          type: "session.task_complete",
          data: { summary: "Emitted the clarification request.", success: true },
        }),
        JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0 }),
      ].join("\n"),
      stderr: "",
    });

    expect(result).toMatchObject({
      terminal: TrellageHeadlessTerminal.Completed,
      finalText: envelope,
      sessionId: "session-1",
    });
  });

  it("accepts a result without task_complete only for a structured question turn", () => {
    const envelope =
      '<trellage_questions version="1">{"questions":[{"id":"color","text":"What color?"}]}</trellage_questions>';
    const result = copilotHeadlessAdapter.parse({
      stdout: [
        JSON.stringify({ type: "assistant.message", data: { content: envelope } }),
        JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0 }),
      ].join("\n"),
      stderr: "",
    });

    expect(result).toMatchObject({
      terminal: TrellageHeadlessTerminal.Completed,
      finalText: envelope,
      sessionId: "session-1",
    });
  });

  it("normalizes OMP Copilot's terminal turn response", async () => {
    const result = ompCopilotHeadlessAdapter.parse({
      stdout: await fixture("omp-copilot-completed.jsonl"),
      stderr: "",
    });

    expect(result).toMatchObject({
      terminal: TrellageHeadlessTerminal.Completed,
      finalText: "Implemented the requested change.",
      sessionId: "omp-copilot-session-1",
      model: "gpt-5.6-sol",
      reportedSuccess: true,
      usage: { input_tokens: 120, output_tokens: 42, total_tokens: 162 },
      tokenUsage: { inputTokens: 120, outputTokens: 42, totalTokens: 162 },
    });
  });

  it("fails when OMP emits an error event", async () => {
    const result = ompCopilotHeadlessAdapter.parse({
      stdout: await fixture("omp-copilot-error.jsonl"),
      stderr: "",
    });

    expect(result).toMatchObject({
      terminal: TrellageHeadlessTerminal.Failed,
      sessionId: "omp-copilot-session-2",
      reportedSuccess: false,
      harnessError: "The Copilot model route is unavailable.",
    });
  });

  it("fails closed when OMP does not emit a terminal agent_end event", async () => {
    const result = ompCopilotHeadlessAdapter.parse({
      stdout: await fixture("omp-copilot-missing-agent-end.jsonl"),
      stderr: "",
    });

    expect(result.terminal).toBe(TrellageHeadlessTerminal.Malformed);
    expect(result.parseWarnings).toContain("missing terminal OMP agent_end event");
  });

  it("routes only the OMP Copilot profile to its adapter", () => {
    expect(headlessAdapterFor(ompCopilotProfile)).toBe(ompCopilotHeadlessAdapter);
    expect(() =>
      headlessAdapterFor({
        ...ompCopilotProfile,
        name: "local",
      }),
    ).toThrow('No headless adapter is registered for launcher "omp" and profile "local".');
  });
});
