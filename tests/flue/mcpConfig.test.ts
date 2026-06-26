import { describe, expect, it } from "vitest";
import { buildFlueMcpSpecs, getEnabledRemoteMcpSpecs } from "../../src/flue/mcpConfig.js";

describe("Flue MCP config", () => {
  it("builds remote MCP specs from environment without embedding secrets", () => {
    const specs = buildFlueMcpSpecs({
      EXA_API_KEY: "exa-secret",
      CONTEXT7_API_KEY: "ctx-key",
    });

    expect(specs).toContainEqual({
      name: "EngHub",
      kind: "remote",
      enabled: true,
      url: "https://mcp.eng.ms",
      transport: "streamable-http",
      tools: ["*"],
    });
    expect(specs).toContainEqual({
      name: "context7",
      kind: "remote",
      enabled: true,
      url: "https://mcp.context7.com/mcp",
      transport: "streamable-http",
      headers: { CONTEXT7_API_KEY: "ctx-key" },
      tools: ["query-docs", "resolve-library-id"],
    });
    const exa = specs.find((spec) => spec.name === "exa");
    expect(exa).toMatchObject({ name: "exa", kind: "remote", enabled: true });
    expect(JSON.stringify(exa)).toContain("exa-secret");
  });

  it("disables secret-backed MCP servers when their env vars are absent", () => {
    const enabled = getEnabledRemoteMcpSpecs({});

    expect(enabled.map((spec) => spec.name)).toEqual(["EngHub"]);
  });

  it("keeps Baton disabled unless local MCPs are explicitly included", () => {
    expect(getEnabledRemoteMcpSpecs({}).map((spec) => spec.name)).not.toContain("baton");
    expect(getEnabledRemoteMcpSpecs({}, { includeLocalBaton: true }).map((spec) => spec.name)).toContain("baton");
  });

  it("marks awesome-copilot stdio as unsupported until a bridge exists", () => {
    const spec = buildFlueMcpSpecs({}).find((item) => item.name === "awesome-copilot");

    expect(spec).toEqual({
      name: "awesome-copilot",
      kind: "unsupported",
      source: "stdio",
      reason: "Installed Flue connectMcpServer supports remote MCP endpoints; bridge the Docker stdio server before exposing it as Flue tools.",
    });
  });
});
