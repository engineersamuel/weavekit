import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z, type ZodType } from "zod";
import { HerdrApiSchemaDocumentSchema } from "./contracts.js";

const execFileAsync = promisify(execFile);
const tracer = trace.getTracer("weavekit");

const ResponseEnvelopeSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.union([z.string(), z.number()]).optional(), message: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const EventEnvelopeSchema = z
  .union([
    z.object({ event: z.string().min(1), data: z.unknown() }).passthrough(),
    z.object({ event: z.string().min(1), payload: z.unknown() }).passthrough(),
    z.object({ method: z.string().min(1), params: z.unknown() }).passthrough(),
  ])
  .transform((event) =>
    "event" in event
      ? { event: event.event, data: "data" in event ? event.data : event.payload }
      : { event: event.method, data: event.params },
  );

type PendingRequest = {
  method: string;
  line: string;
  schema: ZodType<unknown>;
  retries: number;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type EventRecord = z.infer<typeof EventEnvelopeSchema>;
type EventWaiter = { poll(): void; reject(error: Error): void; reconnects: number };

export type HerdrSocketClientOptions = {
  socketPath: string;
  requestTimeoutMs?: number;
  reconnectAttempts?: number;
  allowedMethods?: ReadonlySet<string>;
};

export class HerdrSocketClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: EventRecord[] = [];
  private readonly eventWaiters = new Set<EventWaiter>();
  private closed = false;

  constructor(private readonly options: HerdrSocketClientOptions) {}

  async request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T> {
    if (this.options.allowedMethods && !this.options.allowedMethods.has(method)) {
      throw new Error(`Herdr method is absent from installed API schema: ${method}`);
    }
    const id = `submind-${process.pid}-${++this.nextId}`;
    const line = `${JSON.stringify({ id, method, params })}\n`;
    return tracer.startActiveSpan(
      "submind.socket.operation",
      {
        attributes: {
          "weavekit.submind.socket.method": method,
          "weavekit.submind.socket.request_id": id,
        },
      },
      async (span) => {
        try {
          const result = await new Promise<T>((resolve, reject) => {
            const timeoutMs = operationTimeoutMs(
              method,
              params,
              this.options.requestTimeoutMs ?? 30_000,
            );
            const timer = setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Herdr request timed out after ${timeoutMs}ms: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
              method,
              line,
              schema,
              retries: this.options.reconnectAttempts ?? 1,
              timer,
              resolve: (value) => resolve(value as T),
              reject,
            });
            void this.send(id).catch((error) => this.rejectPending(id, asError(error)));
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const exception = asError(error);
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
          throw exception;
        } finally {
          span.end();
        }
      },
    );
  }

  async waitForEvent<T>(event: string, schema: ZodType<T>, timeoutMs = 30_000): Promise<T> {
    const existing = this.takeEvent(event, schema);
    if (existing !== undefined) return existing;
    return new Promise<T>((resolve, reject) => {
      let waiter: EventWaiter;
      const poll = () => {
        try {
          const value = this.takeEvent(event, schema);
          if (value === undefined) return;
          clearTimeout(timer);
          this.eventWaiters.delete(waiter);
          resolve(value);
        } catch (error) {
          clearTimeout(timer);
          this.eventWaiters.delete(waiter);
          reject(asError(error));
        }
      };
      const timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for Herdr event: ${event}`));
      }, timeoutMs);
      waiter = {
        poll,
        reconnects: this.options.reconnectAttempts ?? 1,
        reject: (error) => {
          clearTimeout(timer);
          this.eventWaiters.delete(waiter);
          reject(error);
        },
      };
      this.eventWaiters.add(waiter);
      void this.connect().catch((error) => {
        waiter.reject(asError(error));
      });
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    for (const [id] of this.pending) this.rejectPending(id, new Error("Herdr client closed"));
    for (const waiter of this.eventWaiters) waiter.reject(new Error("Herdr client closed"));
    this.eventWaiters.clear();
  }

  private async send(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    const socket = await this.connect();
    await new Promise<void>((resolve, reject) => {
      socket.write(pending.line, (error) => (error ? reject(error) : resolve()));
    });
  }

  private connect(): Promise<Socket> {
    if (this.closed) return Promise.reject(new Error("Herdr client is closed"));
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.on("error", () => undefined);
        socket.on("data", (chunk) => this.onData(chunk.toString()));
        socket.on("close", () => this.onDisconnect(socket));
        this.socket = socket;
        resolve(socket);
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        const error = new Error("Herdr socket returned malformed NDJSON");
        this.rejectAll(error);
        this.rejectEventWaiters(error);
        continue;
      }
      const response = ResponseEnvelopeSchema.safeParse(raw);
      if (response.success && this.pending.has(String(response.data.id))) {
        this.resolveResponse(String(response.data.id), response.data);
        continue;
      }
      const event = EventEnvelopeSchema.safeParse(raw);
      if (event.success) {
        this.events.push(event.data);
        for (const waiter of this.eventWaiters) waiter.poll();
      }
    }
  }

  private resolveResponse(id: string, envelope: z.infer<typeof ResponseEnvelopeSchema>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (envelope.error) {
      pending.reject(
        new Error(`${envelope.error.code ?? "herdr_error"}: ${envelope.error.message}`),
      );
      this.releaseIdleSocket();
      return;
    }
    const result = pending.schema.safeParse(envelope.result);
    if (!result.success) {
      pending.reject(new Error(`Herdr returned invalid response: ${result.error.message}`));
      this.releaseIdleSocket();
      return;
    }
    pending.resolve(result.data);
    this.releaseIdleSocket();
  }

  private releaseIdleSocket(): void {
    if (this.pending.size > 0 || this.eventWaiters.size > 0) return;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }

  private onDisconnect(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.buffer = "";
    if (this.closed) return;
    for (const [id, pending] of this.pending) {
      if (pending.retries <= 0 || !isReconnectSafe(pending.method)) {
        this.rejectPending(
          id,
          new Error(`Herdr socket disconnected with ambiguous operation state: ${pending.method}`),
        );
        continue;
      }
      pending.retries -= 1;
      void this.send(id).catch((error) => this.rejectPending(id, asError(error)));
    }
    let reconnectEvents = false;
    for (const waiter of this.eventWaiters) {
      if (waiter.reconnects <= 0) {
        waiter.reject(new Error("Herdr socket disconnected while waiting for an event"));
        continue;
      }
      waiter.reconnects -= 1;
      reconnectEvents = true;
    }
    if (reconnectEvents) {
      void this.connect().catch((error) => this.rejectEventWaiters(asError(error)));
    }
  }

  private takeEvent<T>(name: string, schema: ZodType<T>): T | undefined {
    for (const [index, event] of this.events.entries()) {
      if (event.event !== name) continue;
      const result = schema.safeParse(event.data);
      if (!result.success) throw new Error(`Herdr returned invalid event: ${result.error.message}`);
      this.events.splice(index, 1);
      return result.data;
    }
    return undefined;
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const [id] of this.pending) this.rejectPending(id, error);
  }

  private rejectEventWaiters(error: Error): void {
    for (const waiter of this.eventWaiters) waiter.reject(error);
  }
}

export async function loadInstalledHerdrApiSchema(cwd: string): Promise<{
  document: z.infer<typeof HerdrApiSchemaDocumentSchema>;
  methods: ReadonlySet<string>;
}> {
  const result = await execFileAsync("herdr", ["api", "schema", "--json"], {
    cwd,
    encoding: "utf8",
  });
  const parsed = HerdrApiSchemaDocumentSchema.safeParse(JSON.parse(result.stdout));
  if (!parsed.success)
    throw new Error(`Installed Herdr API schema is invalid: ${parsed.error.message}`);
  return { document: parsed.data, methods: collectMethodNames(parsed.data) };
}

export function collectMethodNames(value: unknown, names = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  const record = value as Record<string, unknown>;
  const properties = asRecord(record.properties);
  const method = asRecord(properties?.method);
  if (typeof method?.const === "string" && method.const.includes(".")) names.add(method.const);
  for (const [key, child] of Object.entries(value)) {
    if ((key === "method" || key === "name") && typeof child === "string" && child.includes(".")) {
      names.add(child);
    }
    if (key.includes(".") && child && typeof child === "object") names.add(key);
    collectMethodNames(child, names);
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isReconnectSafe(method: string): boolean {
  return !new Set([
    "pane.split",
    "pane.send_input",
    "agent.start",
    "agent.rename",
    "agent.prompt",
  ]).has(method);
}

function operationTimeoutMs(method: string, params: unknown, defaultTimeoutMs: number): number {
  if (method !== "agent.wait" || !params || typeof params !== "object" || Array.isArray(params)) {
    return defaultTimeoutMs;
  }
  const requested = (params as Record<string, unknown>).timeout_ms;
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(defaultTimeoutMs, requested + 5_000)
    : defaultTimeoutMs;
}
