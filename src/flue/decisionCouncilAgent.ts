import { defineAgent, type ToolDefinition } from "@flue/runtime";
import type { FlueDefaults } from "../config.js";
import usingSuperpowers from "../skills/using-superpowers/SKILL.md" with { type: "skill" };

export function createDecisionCouncilAgent(args: { tools?: ToolDefinition[]; model?: string; config?: FlueDefaults } = {}) {
  return defineAgent(() => ({
    model: args.model ?? args.config?.model ?? "anthropic/claude-haiku-4-5",
    tools: args.tools ?? [],
    skills: [usingSuperpowers],
    instructions:
      "You host finite Decision Council workflow runs. Application code controls the council loop, typed BAML reductions, and final outputs. Use the using-superpowers skill when planning or executing agentic work.",
  }));
}
