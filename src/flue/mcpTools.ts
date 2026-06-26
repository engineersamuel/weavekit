import { connectMcpServer, type McpServerConnection, type McpServerOptions, type ToolDefinition } from "@flue/runtime";
import type { RemoteFlueMcpSpec } from "./mcpConfig.js";

export type ConnectMcpServer = (
  name: string,
  options: McpServerOptions,
) => Promise<McpServerConnection>;

function normalizeFlueToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function isAllowedTool(tool: ToolDefinition, spec: RemoteFlueMcpSpec): boolean {
  if (!spec.tools || spec.tools.includes("*")) return true;

  return spec.tools.some((allowed) => {
    const normalized = normalizeFlueToolName(allowed);
    return tool.name === allowed || tool.name === normalized || tool.name === `mcp__${spec.name}__${normalized}`;
  });
}

export async function connectConfiguredMcpTools(
  specs: RemoteFlueMcpSpec[],
  connect: ConnectMcpServer = connectMcpServer as ConnectMcpServer,
): Promise<{ tools: ToolDefinition[]; connections: McpServerConnection[]; close(): Promise<void> }> {
  const connections: McpServerConnection[] = [];

  try {
    for (const spec of specs) {
      const options: McpServerOptions = {
        url: spec.url,
        transport: spec.transport,
      };
      if (spec.headers) options.headers = spec.headers;
      if (spec.timeoutMs !== undefined) options.timeoutMs = spec.timeoutMs;
      const connection = await connect(spec.name, options);
      connections.push({
        name: connection.name,
        tools: connection.tools.filter((tool) => isAllowedTool(tool, spec)),
        close: () => connection.close(),
      });
    }
  } catch (error) {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    throw error;
  }

  return {
    tools: connections.flatMap((connection) => connection.tools),
    connections,
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  };
}
