import { describe, expect, it } from "vitest";
import IsolatedPromptfooRouterProvider from "../../scripts/promptfoo-router-provider-isolated.js";

describe("IsolatedPromptfooRouterProvider", () => {
  it("loads the current router implementation in a fresh process", async () => {
    const provider = new IsolatedPromptfooRouterProvider({
      config: { mode: "deterministic" },
    });

    const response = await provider.callApi(
      "Create worktree with herdr. Project: weavekit Branch: router Agent: codex. Implement the router workflow.",
    );

    expect(response.error).toBeUndefined();
    expect(response.output).toContain("complete project, branch or worktree");
    expect(response.output).toContain("Alternatives: local-code-change, grill-with-docs");
    expect(response.output).toContain("Warnings: Do not auto-launch");
  }, 15_000);
});
