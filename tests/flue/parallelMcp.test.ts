import { defineAgent, registerProvider } from "@flue/runtime";
import {
  Bash,
  InMemorySessionStore,
  bashFactoryToSessionEnv,
  initializeRootHarness,
  resolveModel,
} from "@flue/runtime/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnabledRemoteMcpSpecs } from "../../src/flue/mcpConfig.js";
import { connectConfiguredMcpTools } from "../../src/flue/mcpTools.js";

const searchArgs = {
  objective: "Find Node.js release notes",
  search_queries: ["Node.js release notes"],
};
const fetchArgs = { urls: ["https://nodejs.org/en/blog/release"] };

function installTransport(mode: "success" | "error" | "pending" = "success") {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const modelInputs: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://model.test/v1/chat/completions") {
        const body = await request.json();
        modelInputs.push(JSON.stringify(body));
        const index = modelInputs.length - 1;
        const toolCall =
          index < 2
            ? {
                index: 0,
                id: `call-${index}`,
                type: "function",
                function: {
                  name: index === 0 ? "mcp__parallel__web_search" : "mcp__parallel__web_fetch",
                  arguments: JSON.stringify(index === 0 ? searchArgs : fetchArgs),
                },
              }
            : undefined;
        const chunk = {
          id: "completion",
          object: "chat.completion.chunk",
          created: 0,
          model: "test",
          choices: [
            {
              index: 0,
              delta: toolCall
                ? { role: "assistant", tool_calls: [toolCall] }
                : { role: "assistant", content: "Research complete." },
              finish_reason: toolCall ? "tool_calls" : "stop",
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      expect(request.url).toBe("https://search.parallel.ai/mcp");
      expect(request.headers.get("User-Agent")).toBe("weavekit/0.0.0");
      expect(request.headers.has("Authorization")).toBe(false);
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = await request.json();
      calls.push(message);
      if (!message.id && message.id !== 0) return new Response(null, { status: 202 });
      let result;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "parallel-fixture", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = {
          tools: ["web_search", "web_fetch", "unlisted"].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object" },
          })),
        };
      } else if (message.method === "tools/call") {
        if (mode === "pending") {
          return new Promise<Response>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                reject(request.signal.reason);
              },
              { once: true },
            );
          });
        }
        result = {
          content: [
            {
              type: "text",
              text:
                mode === "error"
                  ? "Search unavailable"
                  : message.params.name === "web_search"
                    ? "Release notes: https://nodejs.org/en/blog/release"
                    : "Node.js release notes page content",
            },
          ],
          isError: mode === "error",
        };
      } else {
        throw new Error(`Unexpected MCP method ${message.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    }),
  );
  return { calls, modelInputs };
}

async function connectParallel(timeoutMs?: number) {
  const specs = getEnabledRemoteMcpSpecs({ WEAVEKIT_PARALLEL_SEARCH: "1" })
    .filter((spec) => spec.name === "parallel")
    .map((spec) => ({ ...spec, ...(timeoutMs === undefined ? {} : { timeoutMs }) }));
  return connectConfiguredMcpTools(specs);
}

async function createHarness(tools: Awaited<ReturnType<typeof connectParallel>>["tools"]) {
  registerProvider("parallel-test", {
    api: "openai-completions",
    baseUrl: "https://model.test/v1",
    apiKey: "fixture",
  });
  return initializeRootHarness(
    defineAgent(() => ({ model: "parallel-test/test", tools })),
    {
      id: "parallel-test",
      env: {},
      agentConfig: { resolveModel },
      createDefaultEnv: () => bashFactoryToSessionEnv(() => new Bash()),
      defaultStore: new InMemorySessionStore(),
    },
    () => undefined,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Parallel MCP through Flue", () => {
  it("discovers allowed tools and consumes search and fetch results in a session", async () => {
    const transport = installTransport();
    const connection = await connectParallel();
    const harness = await createHarness(connection.tools);
    try {
      expect(connection.tools.map((tool) => tool.name)).toEqual([
        "mcp__parallel__web_search",
        "mcp__parallel__web_fetch",
      ]);
      const session = await harness.session();
      await session.prompt("Research Node.js releases.");
      expect(
        transport.calls.filter((call) => call.method === "tools/call").map((call) => call.params),
      ).toEqual([
        { name: "web_search", arguments: searchArgs },
        { name: "web_fetch", arguments: fetchArgs },
      ]);
      expect(transport.modelInputs[1]).toContain(
        "Release notes: https://nodejs.org/en/blog/release",
      );
      expect(transport.modelInputs[2]).toContain("Node.js release notes page content");
    } finally {
      await harness.close();
      await connection.close();
    }
  });

  it("surfaces MCP tool errors to the session", async () => {
    const transport = installTransport("error");
    const connection = await connectParallel();
    const harness = await createHarness(connection.tools);
    try {
      await (await harness.session()).prompt("Research Node.js releases.");
      expect(transport.modelInputs[1]).toContain("Search unavailable");
    } finally {
      await harness.close();
      await connection.close();
    }
  });

  it("retains the existing request timeout behavior", async () => {
    const transport = installTransport("pending");
    const connection = await connectParallel(20);
    const harness = await createHarness(connection.tools);
    try {
      await (await harness.session()).prompt("Research Node.js releases.");
      expect(transport.modelInputs[1]).toContain("Request timed out");
      expect(transport.calls.some((call) => call.method === "notifications/cancelled")).toBe(true);
    } finally {
      await harness.close();
      await connection.close();
    }
  });

  it("cancels an in-flight MCP request when the session is aborted", async () => {
    const transport = installTransport("pending");
    const connection = await connectParallel();
    const harness = await createHarness(connection.tools);
    try {
      const operation = (await harness.session()).prompt("Research Node.js releases.");
      const rejected = expect(operation).rejects.toThrow();
      await vi.waitFor(() =>
        expect(transport.calls.some((call) => call.method === "tools/call")).toBe(true),
      );
      operation.abort();
      await rejected;
      await vi.waitFor(() =>
        expect(transport.calls.some((call) => call.method === "notifications/cancelled")).toBe(
          true,
        ),
      );
    } finally {
      await harness.close();
      await connection.close();
    }
  });
});
