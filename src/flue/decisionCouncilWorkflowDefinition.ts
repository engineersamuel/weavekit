import { defineWorkflow, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { DecisionCouncilRunStateSchema } from "../decision-council/types.js";
import { type DecisionCouncilWorkflowDeps, runDecisionCouncilLoop } from "../decision-council/workflow.js";
import { createDecisionCouncilAgent } from "./decisionCouncilAgent.js";

export type DecisionCouncilFlueOptions = {
  flueTools?: ToolDefinition[];
  flueModel?: string;
};

// Keep Flue registration separate from the direct CLI/library loop so Node/tsx
// entrypoints do not eagerly load packaged skill assets.
export function createDecisionCouncilWorkflow(
  deps: DecisionCouncilWorkflowDeps,
  options: DecisionCouncilFlueOptions = {},
) {
  return defineWorkflow({
    agent: createDecisionCouncilAgent({ tools: options.flueTools, model: options.flueModel }),
    input: v.looseObject({}),
    output: v.looseObject({}),
    async run({ input }) {
      return await runDecisionCouncilLoop(DecisionCouncilRunStateSchema.parse(input), deps);
    },
  });
}
