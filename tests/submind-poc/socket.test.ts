import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { collectMethodNames, HerdrSocketClient } from "../../src/submind-poc/socket.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("HerdrSocketClient", () => {
  it("extracts methods from the installed Herdr 0.8 JSON Schema shape", () => {
    const schema = {
      schemas: {
        request: {
          oneOf: [
            {
              properties: {
                method: { const: "session.snapshot", type: "string" },
                params: { type: "object" },
              },
              required: ["method", "params"],
              type: "object",
            },
          ],
        },
      },
    };

    expect(collectMethodNames(schema)).toContain("session.snapshot");
  });

  it("frames split NDJSON and correlates out-of-order responses", async () => {
    const { path, sockets } = await socketServer((socket) => {
      let buffer = "";
      const requests: Array<{ id: string }> = [];
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          requests.push(JSON.parse(buffer.slice(0, index)) as { id: string });
          buffer = buffer.slice(index + 1);
        }
        if (requests.length === 2) {
          const payload = `${JSON.stringify({ id: requests[1]!.id, result: { value: 2 } })}\n${JSON.stringify({ id: requests[0]!.id, result: { value: 1 } })}\n`;
          socket.write(payload.slice(0, 13));
          socket.write(payload.slice(13));
        }
      });
    });
    const client = new HerdrSocketClient({ socketPath: path });
    cleanups.push(async () => client.close());

    const [first, second] = await Promise.all([
      client.request("one", {}, z.object({ value: z.literal(1) })),
      client.request("two", {}, z.object({ value: z.literal(2) })),
    ]);

    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
    expect(sockets.size).toBe(1);
  });

  it("opens a fresh connection for each sequential request batch", async () => {
    let connections = 0;
    const { path } = await socketServer((socket) => {
      connections += 1;
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString().trim()) as { id: string };
        socket.write(`${JSON.stringify({ id: request.id, result: { value: connections } })}\n`);
      });
    });
    const client = new HerdrSocketClient({ socketPath: path });
    cleanups.push(async () => client.close());

    await expect(client.request("first", {}, z.object({ value: z.literal(1) }))).resolves.toEqual({
      value: 1,
    });
    await expect(client.request("second", {}, z.object({ value: z.literal(2) }))).resolves.toEqual({
      value: 2,
    });
    expect(connections).toBe(2);
  });

  it("rejects bad response schemas and timed-out requests", async () => {
    let responded = false;
    const { path } = await socketServer((socket) => {
      socket.once("data", (chunk) => {
        if (responded) return;
        responded = true;
        const request = JSON.parse(chunk.toString().trim()) as { id: string };
        socket.write(`${JSON.stringify({ id: request.id, result: { value: "bad" } })}\n`);
      });
    });
    const client = new HerdrSocketClient({ socketPath: path, requestTimeoutMs: 25 });
    cleanups.push(async () => client.close());

    await expect(client.request("bad", {}, z.object({ value: z.number() }))).rejects.toThrow(
      "invalid response",
    );
    await expect(client.request("never", {}, z.unknown())).rejects.toThrow("timed out");
  });

  it("waits for one matching event and reconnects after disconnect", async () => {
    let connection = 0;
    const { path } = await socketServer((socket) => {
      connection += 1;
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString().trim()) as { id: string };
        if (connection === 1) {
          socket.destroy();
          return;
        }
        socket.write(`${JSON.stringify({ event: "agent.status", data: { state: "working" } })}\n`);
        socket.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
      });
    });
    const client = new HerdrSocketClient({ socketPath: path, reconnectAttempts: 1 });
    cleanups.push(async () => client.close());

    await expect(client.request("retry", {}, z.object({ ok: z.literal(true) }))).resolves.toEqual({
      ok: true,
    });
    await expect(
      client.waitForEvent("agent.status", z.object({ state: z.literal("working") }), 100),
    ).resolves.toEqual({ state: "working" });
  });

  it.each(["agent.prompt", "pane.send_input"])(
    "does not replay mutating %s after an ambiguous disconnect",
    async (method) => {
      let connections = 0;
      const { path } = await socketServer((socket) => {
        connections += 1;
        socket.once("data", () => socket.destroy());
      });
      const client = new HerdrSocketClient({ socketPath: path, reconnectAttempts: 2 });
      cleanups.push(async () => client.close());

      await expect(client.request(method, {}, z.unknown())).rejects.toThrow(
        "ambiguous operation state",
      );
      expect(connections).toBe(1);
    },
  );

  it("connects for event-only waits and rejects malformed matching events", async () => {
    const { path } = await socketServer((socket) => {
      socket.write(`${JSON.stringify({ event: "agent.status", data: { state: 7 } })}\n`);
    });
    const client = new HerdrSocketClient({ socketPath: path });
    cleanups.push(async () => client.close());

    await expect(
      client.waitForEvent("agent.status", z.object({ state: z.string() }), 100),
    ).rejects.toThrow("invalid event");
  });

  it("reconnects an event-only waiter after an established connection disconnects", async () => {
    let connections = 0;
    const { path } = await socketServer((socket) => {
      connections += 1;
      if (connections === 1) {
        setImmediate(() => socket.destroy());
        return;
      }
      socket.write(`${JSON.stringify({ event: "agent.status", data: { state: "idle" } })}\n`);
    });
    const client = new HerdrSocketClient({ socketPath: path, reconnectAttempts: 1 });
    cleanups.push(async () => client.close());

    await expect(
      client.waitForEvent("agent.status", z.object({ state: z.literal("idle") }), 200),
    ).resolves.toEqual({ state: "idle" });
    expect(connections).toBe(2);
  });

  it("rejects event-only waiters when the socket emits malformed NDJSON", async () => {
    const { path } = await socketServer((socket) => socket.write("{not-json}\n"));
    const client = new HerdrSocketClient({ socketPath: path });
    cleanups.push(async () => client.close());

    await expect(
      client.waitForEvent("agent.status", z.object({ state: z.string() }), 200),
    ).rejects.toThrow("malformed NDJSON");
  });
});

async function socketServer(onConnection: (socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), "submind-socket-"));
  const path = join(directory, "herdr.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  });
  return { path, sockets };
}
