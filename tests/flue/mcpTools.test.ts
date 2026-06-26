import type { McpServerConnection } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import { connectConfiguredMcpTools } from "../../src/flue/mcpTools.js";
import type { RemoteFlueMcpSpec } from "../../src/flue/mcpConfig.js";

const specs: RemoteFlueMcpSpec[] = [
  { name: "EngHub", kind: "remote", enabled: true, url: "https://mcp.eng.ms", transport: "streamable-http" },
  { name: "context7", kind: "remote", enabled: true, url: "https://mcp.context7.com/mcp", transport: "streamable-http", headers: { CONTEXT7_API_KEY: "secret" }, tools: ["query-docs"] },
];

describe("connectConfiguredMcpTools", () => {
  it("connects each remote spec and aggregates tools", async () => {
    const close = vi.fn(async () => undefined);
    const tool = (name: string) => ({ name } as never);
    const connect = vi.fn(async (name: string) => ({
      name,
      tools: name === "context7"
        ? [tool("mcp__context7__query_docs"), tool("mcp__context7__unlisted")]
        : [tool(`tool:${name}`)],
      close,
    }) satisfies McpServerConnection);

    const result = await connectConfiguredMcpTools(specs, connect);

    expect(connect).toHaveBeenCalledWith("EngHub", { url: "https://mcp.eng.ms", transport: "streamable-http" });
    expect(connect).toHaveBeenCalledWith("context7", {
      url: "https://mcp.context7.com/mcp",
      transport: "streamable-http",
      headers: { CONTEXT7_API_KEY: "secret" },
    });
    expect(result.tools.map((item) => item.name)).toEqual(["tool:EngHub", "mcp__context7__query_docs"]);
  });

  it("closes all opened connections", async () => {
    const closeA = vi.fn(async () => undefined);
    const closeB = vi.fn(async () => undefined);
    const connect = vi.fn(async (name: string) => ({ name, tools: [], close: name === "EngHub" ? closeA : closeB }) satisfies McpServerConnection);

    const result = await connectConfiguredMcpTools(specs, connect);
    await result.close();

    expect(closeA).toHaveBeenCalledOnce();
    expect(closeB).toHaveBeenCalledOnce();
  });

  it("closes already-opened connections when a later connection fails", async () => {
    const closeA = vi.fn(async () => undefined);
    const connect = vi.fn(async (name: string) => {
      if (name === "context7") throw new Error("context7 unavailable");
      return { name, tools: [], close: closeA } satisfies McpServerConnection;
    });

    await expect(connectConfiguredMcpTools(specs, connect)).rejects.toThrow("context7 unavailable");
    expect(closeA).toHaveBeenCalledOnce();
  });

  it("skips disabled specs and does not connect to them", async () => {
    const specsWithDisabled: RemoteFlueMcpSpec[] = [
      { name: "EngHub", kind: "remote", enabled: true, url: "https://mcp.eng.ms", transport: "streamable-http" },
      { name: "context7", kind: "remote", enabled: false, url: "https://mcp.context7.com/mcp", transport: "streamable-http", tools: ["query-docs"] },
    ];
    const connect = vi.fn(async (name: string) => ({ name, tools: [], close: vi.fn(async () => undefined) }) satisfies McpServerConnection);

    const result = await connectConfiguredMcpTools(specsWithDisabled, connect);

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith("EngHub", { url: "https://mcp.eng.ms", transport: "streamable-http" });
    expect(connect).not.toHaveBeenCalledWith("context7", expect.any(Object));
    expect(result.connections).toHaveLength(1);
  });

  it("preserves async Promise<void> signature for wrapped close function", async () => {
    const innerClose = vi.fn(async () => undefined);
    const connect = vi.fn(async (name: string) => ({ name, tools: [], close: innerClose }) satisfies McpServerConnection);

    const result = await connectConfiguredMcpTools(specs, connect);
    const wrappedClose = result.connections[0].close;

    expect(wrappedClose()).toBeInstanceOf(Promise);
    await wrappedClose();
    expect(innerClose).toHaveBeenCalled();
  });
});
