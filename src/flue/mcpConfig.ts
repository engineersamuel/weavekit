export type FlueMcpServerName = "exa" | "EngHub" | "baton" | "context7" | "awesome-copilot";

export type RemoteFlueMcpSpec = {
  name: FlueMcpServerName;
  kind: "remote";
  enabled: boolean;
  url: string;
  transport: "streamable-http" | "sse";
  headers?: Record<string, string>;
  timeoutMs?: number;
  tools?: string[];
};

export type UnsupportedFlueMcpSpec = {
  name: FlueMcpServerName;
  kind: "unsupported";
  source: "stdio";
  reason: string;
};

export type FlueMcpSpec = RemoteFlueMcpSpec | UnsupportedFlueMcpSpec;

export function buildFlueMcpSpecs(
  env: NodeJS.ProcessEnv,
  options: { includeLocalBaton?: boolean } = {},
): FlueMcpSpec[] {
  const specs: FlueMcpSpec[] = [
    {
      name: "exa",
      kind: "remote",
      enabled: Boolean(env.EXA_API_KEY),
      // Note: Exa MCP server requires the API key in the URL at runtime.
      // Runtime secrets like env.EXA_API_KEY are passed as connection parameters, not hardcoded from config files.
      url: env.EXA_API_KEY ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(env.EXA_API_KEY)}` : "https://mcp.exa.ai/mcp",
      transport: "streamable-http",
      tools: ["*"],
    },
    {
      name: "EngHub",
      kind: "remote",
      enabled: true,
      url: "https://mcp.eng.ms",
      transport: "streamable-http",
      tools: ["*"],
    },
    {
      name: "baton",
      kind: "remote",
      enabled: options.includeLocalBaton === true,
      url: "http://localhost:53724/mcp",
      transport: "streamable-http",
      tools: ["*"],
    },
    {
      name: "context7",
      kind: "remote",
      enabled: Boolean(env.CONTEXT7_API_KEY),
      url: "https://mcp.context7.com/mcp",
      transport: "streamable-http",
      headers: env.CONTEXT7_API_KEY ? { CONTEXT7_API_KEY: env.CONTEXT7_API_KEY } : undefined,
      tools: ["query-docs", "resolve-library-id"],
    },
    {
      name: "awesome-copilot",
      kind: "unsupported",
      source: "stdio",
      reason: "Installed Flue connectMcpServer supports remote MCP endpoints; bridge the Docker stdio server before exposing it as Flue tools.",
    },
  ];

  return specs;
}

export function getEnabledRemoteMcpSpecs(
  env: NodeJS.ProcessEnv,
  options: { includeLocalBaton?: boolean } = {},
): RemoteFlueMcpSpec[] {
  return buildFlueMcpSpecs(env, options).filter(
    (spec): spec is RemoteFlueMcpSpec => spec.kind === "remote" && spec.enabled,
  );
}
