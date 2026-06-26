import type { ToolDefinition } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { createDecisionCouncilAgent } from "../../src/flue/decisionCouncilAgent.js";

describe("createDecisionCouncilAgent", () => {
  it("creates a Flue agent with Superpowers skill and supplied MCP tools", async () => {
    const tool = { name: "mcp__EngHub__search" } as ToolDefinition;
    const agent = createDecisionCouncilAgent({ tools: [tool], model: "github-copilot/gpt-4o" });
    const config = await agent.initialize({ id: "test" } as never);

    expect(config.model).toBe("github-copilot/gpt-4o");
    expect(config.tools).toContain(tool);
    expect(config.skills).toHaveLength(1);
    expect(config.instructions).toContain("Decision Council");
  });
});
