import { describe, expect, it } from "vitest";
import { RlmProfileAuthority, RlmProfilePurpose } from "../../src/rlm-poc/contracts.js";
import { createRlmProfileRegistry } from "../../src/rlm-poc/profiles.js";
import {
  RLM_SUBMIND_SYSTEM_PROMPT,
  buildRlmSubmindSystemPrompt,
} from "../../src/rlm-poc/submindPrompt.js";

describe("RLM_SUBMIND_SYSTEM_PROMPT", () => {
  it("adapts the Submind orchestration contract to recursive rlm calls", () => {
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("rlm({ prompt:");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Plan Before Delegation");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Independent Review");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Verify the Work");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("ask_user");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "Native `ask_user` is a supported and desirable way",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "snapshot of this root Submind's complete conversation",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Do not discourage or work around `ask_user`");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).not.toContain(
      "Tell the recursive session not to ask the human",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("complete main\nconversation");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "issue their `rlm` tool calls\n   together in the same assistant turn",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Do not\n   serialize independent calls");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("enforces at most 12 total `rlm` calls");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`needs_human`");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`validation` (validation):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`general` (execution):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`superpowers` (execution):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`council` (deliberation):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`research` (research):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`design` (design):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`media` (media):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`review` (review):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Always consider whether a bounded");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "design profile prefers current\n  frontier Claude/Opus candidates",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "every `research` call must invoke `hyperresearch` or",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("every `media` call must invoke `watch-video`");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "route video transcription and media analysis to `media`",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "YouTube/video URL or asking to watch, transcribe, summarize, or analyze",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Local Model Compatibility Proxy");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("http://127.0.0.1:8080/v1");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("/v1/messages");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("/v1/models");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("compatibility bridge");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Telegram Notifications");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`TG_BOT_ID` and `TG_CHAT_ID`");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "https://api.telegram.org/bot${TG_BOT_ID}/sendMessage",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("remain under 300 characters");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toMatch(/send\s+exactly one/u);
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "Unless a stuck-recovery question was already sent",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toMatch(
      /must never print, echo, or\s+return either credential/u,
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("If you are completely stuck");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "require it to invoke its loaded\n   `rlm-handoff` skill",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("one new Herdr-managed agent");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("same Herdr worktree");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toMatch(/precise\s+blocker/u);
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("routing and synthesis meta-harness");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Do not\nperform specialized implementation");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "A primarily visual deliverable must route through the `design` profile",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("DNS topology or resolution-flow diagrams");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Delegate even trivial execution work");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Delegate trusted deterministic checks");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "All work and every delegated result — implementation, research, design, media analysis",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "must be validated and verified to the best of the\n  responsible model's ability",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "This requirement applies to all work, not only repository edits",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain(
      "with its available tools; no profile may treat unsupported prose as verification",
    );
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("diff text needed by a later reviewer");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).not.toContain("Handle trivial work directly");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).not.toContain(
      "1. Run the repository's trusted deterministic checks",
    );
  });

  it("limits fallback handoff to a managed agent in the same worktree", () => {
    expect(RLM_SUBMIND_SYSTEM_PROMPT).not.toMatch(/Trellage|pane|launcher/iu);
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("start at most one new Herdr-managed agent");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toMatch(/Do not\s+create another worktree/u);
  });

  it("generates inventory and budget guidance from runtime configuration", () => {
    const registry = createRlmProfileRegistry({
      specialist: {
        name: "specialist",
        description: "Specialist profile supplied by the caller.",
        purpose: RlmProfilePurpose.Submind,
        authority: RlmProfileAuthority.Implementation,
        repositoryWritePermission: true,
        model: "test-model",
        systemMessagePrompt: "Specialize.",
      },
    });

    const prompt = buildRlmSubmindSystemPrompt(registry, { maxTotalCalls: 7 });

    expect(prompt).toContain("`specialist` (submind): Specialist profile supplied by the caller.");
    expect(prompt).toContain("enforces at most 7 total `rlm` calls");
  });

  it("prefers safer live-discovered Trellage profiles while preserving useful fallbacks", () => {
    const prompt = buildRlmSubmindSystemPrompt(defaultTestRegistry(), {
      maxTotalCalls: 7,
      trellageEnabled: true,
    });

    expect(prompt).toContain("`trellage list --json` and `trx list --json`");
    expect(prompt).toContain(
      "prefer a\n  sandboxed native launcher, then a container profile, then an unsandboxed native launcher",
    );
    expect(prompt).toContain("Sandboxing is a strong safety preference, not a hard requirement");
    expect(prompt).toContain("Herdr-owned interactive PTY");
    expect(prompt).toContain("never replace this with piped subprocess output");
  });
});

function defaultTestRegistry() {
  return createRlmProfileRegistry({
    general: {
      name: "general",
      description: "General worker.",
      purpose: RlmProfilePurpose.Execution,
      authority: RlmProfileAuthority.Implementation,
      repositoryWritePermission: true,
      model: "test-model",
      systemMessagePrompt: "Work.",
    },
  });
}
