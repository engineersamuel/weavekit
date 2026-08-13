import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HerdrSocketClient, loadInstalledHerdrApiSchema } from "./socket.js";

const execFileAsync = promisify(execFile);

/**
 * Connects to the Herdr control socket, validating every method this process may send against the
 * schema the *installed* Herdr reports, so a version skew fails at connect time rather than
 * mid-run.
 */
export async function createHerdrClient(cwd: string): Promise<HerdrSocketClient> {
  const { document, methods } = await loadInstalledHerdrApiSchema(cwd);
  const socketPath = await resolveHerdrSocketPath(cwd, document);
  return new HerdrSocketClient({ socketPath, allowedMethods: methods });
}

/** Runs `operation` against a fresh client and always closes it. */
export async function withHerdrClient<T>(
  cwd: string,
  operation: (client: HerdrSocketClient) => Promise<T>,
): Promise<T> {
  const client = await createHerdrClient(cwd);
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

export async function resolveHerdrSocketPath(
  cwd: string,
  schemaDocument: unknown,
): Promise<string> {
  const fromEnvironment =
    process.env.HERDR_SOCKET_PATH ?? process.env.HERDR_API_SOCKET ?? process.env.HERDR_SOCKET;
  if (fromEnvironment) return fromEnvironment;
  const fromSchema = findSocketPath(schemaDocument);
  if (fromSchema) return fromSchema;
  try {
    const result = await execFileAsync("herdr", ["api", "socket", "--json"], {
      cwd,
      encoding: "utf8",
    });
    const path = findSocketPath(JSON.parse(result.stdout));
    if (path) return path;
  } catch {
    // Fall through to explicit error.
  }
  throw new Error(
    "Herdr socket path is unavailable; expected inherited Herdr socket environment or API discovery.",
  );
}

/** True when this process is running inside a Herdr-managed terminal. */
export function isHerdrEnvironment(): boolean {
  return process.env.HERDR_ENV === "1";
}

export function findSocketPath(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findSocketPath(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["socket_path", "socketPath"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  const socketRecord = [record.kind, record.type, record.name].some(
    (field) => typeof field === "string" && field.toLowerCase().includes("socket"),
  );
  if (socketRecord && typeof record.path === "string" && record.path) return record.path;
  for (const child of Object.values(record)) {
    const found = findSocketPath(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * True when a mutation failed with Herdr's "ambiguous operation state" reconnect guard, meaning the
 * request may or may not have taken effect and the caller must re-observe rather than retry.
 */
export function isAmbiguousHerdrMutation(error: unknown): boolean {
  return String(error).includes("ambiguous operation state");
}
