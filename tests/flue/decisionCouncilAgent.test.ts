import type { ToolDefinition } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { createDecisionCouncilAgent } from "../../src/flue/decisionCouncilAgent.js";

describe("createDecisionCouncilAgent", () => {
  it("creates a Flue agent with Superpowers skill and supplied MCP tools", async () => {
    const tool = { name: "mcp__EngHub__search" } as ToolDefinition;
    const agent = createDecisionCouncilAgent({ tools: [tool], model: "anthropic/claude-sonnet-4-6" });
    const config = await agent.initialize({ id: "test" } as never);

    expect(config.model).toBe("anthropic/claude-sonnet-4-6");
    expect(config.tools).toContain(tool);
    expect(config.skills).toHaveLength(1);
    expect(config.instructions).toContain("Decision Council");
  });

  it("uses the typed Flue config model when supplied", async () => {
    const agent = createDecisionCouncilAgent({
      config: { model: "anthropic/claude-haiku-4-5" },
    });
    const config = await agent.initialize({ id: "test" } as never);

    expect(config.model).toBe("anthropic/claude-haiku-4-5");
  });
});
