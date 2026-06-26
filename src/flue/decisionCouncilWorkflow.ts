import type { McpServerConnection, ToolDefinition } from "@flue/runtime";
import {
  createDecisionCouncilWorkflow,
  type DecisionCouncilWorkflowDeps,
} from "../decision-council/workflow.js";
import { getEnabledRemoteMcpSpecs } from "./mcpConfig.js";
import { connectConfiguredMcpTools, type ConnectMcpServer } from "./mcpTools.js";

export type ConfiguredDecisionCouncilWorkflowOptions = {
  env?: NodeJS.ProcessEnv;
  includeLocalBaton?: boolean;
  flueModel?: string;
  connectMcpServer?: ConnectMcpServer;
};

export async function createConfiguredDecisionCouncilWorkflow(
  deps: DecisionCouncilWorkflowDeps,
  options: ConfiguredDecisionCouncilWorkflowOptions = {},
): Promise<{
  workflow: ReturnType<typeof createDecisionCouncilWorkflow>;
  tools: ToolDefinition[];
  connections: McpServerConnection[];
  close(): Promise<void>;
}> {
  const specs = getEnabledRemoteMcpSpecs(options.env ?? process.env, {
    includeLocalBaton: options.includeLocalBaton,
  });
  const mcp = await connectConfiguredMcpTools(specs, options.connectMcpServer);

  return {
    workflow: createDecisionCouncilWorkflow(deps, {
      flueTools: mcp.tools,
      flueModel: options.flueModel,
    }),
    tools: mcp.tools,
    connections: mcp.connections,
    close: mcp.close,
  };
}
