import { defineAgent, type ToolDefinition } from "@flue/runtime";
import usingSuperpowers from "../skills/using-superpowers/SKILL.md" with { type: "skill" };

export function createDecisionCouncilAgent(args: { tools?: ToolDefinition[]; model?: string } = {}) {
  return defineAgent(() => ({
    model: args.model ?? process.env.WEAVEKIT_FLUE_MODEL ?? "anthropic/claude-haiku-4-5",
    tools: args.tools ?? [],
    skills: [usingSuperpowers],
    instructions:
      "You host finite Decision Council workflow runs. Application code controls the council loop, typed BAML reductions, and final outputs. Use the using-superpowers skill when planning or executing agentic work.",
  }));
}
