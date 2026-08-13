import { spawn } from "node:child_process";
import { Trace } from "./trace.js";

export type CodeActResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
  timedOut?: boolean;
  stderr?: string;
};

export class CodeActRunner {
  private readonly trace: Trace;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  async run(jsCode: string, input: unknown, timeoutMs = 2000): Promise<CodeActResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new Error("CodeAct timeout must be a positive number.");
    }
    this.trace.push("codeact.run.start", "starting CodeAct child");

    const child = spawn(process.execPath, ["--permission", "--eval", CODEACT_BOOTSTRAP], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    child.stdin.write(JSON.stringify({ code: jsCode, input }));
    child.stdin.end();

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    return await new Promise<CodeActResult>((resolve) => {
      const onDone = (_code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!isCodeActResult(parsed)) {
            resolve({ ok: false, error: "bad-response-shape", stderr });
            return;
          }
          this.trace.push(
            parsed.ok ? "codeact.run.end" : "codeact.run.error",
            parsed.ok ? "CodeAct completed" : (parsed.error ?? "CodeAct failed"),
          );
          resolve({ ...parsed, ...(stderr ? { stderr } : {}) });
        } catch (err) {
          resolve({
            ok: false,
            error: stdout ? "bad-json-response" : "no-output",
            stderr: [stderr, String(err)].filter(Boolean).join("\n"),
          });
        }
      };

      child.on("close", onDone);
      child.on("error", (e) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ok: false, error: String(e), stderr });
      });

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          child.kill("SIGKILL");
          this.trace.push("codeact.run.timeout", "child killed for timeout");
          resolve({ ok: false, error: "timeout", timedOut: true, stderr });
        }
      }, timeoutMs);
    });
  }
}

function isCodeActResult(value: unknown): value is CodeActResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.ok === "boolean" &&
    (result.error === undefined || typeof result.error === "string") &&
    (result.timedOut === undefined || typeof result.timedOut === "boolean")
  );
}

const CODEACT_BOOTSTRAP = String.raw`
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("error", fail);
process.stdin.on("end", async () => {
  try {
    if (!process.permission || typeof process.permission.has !== "function") {
      throw new Error("permission-model-unavailable");
    }
    for (const scope of ["fs.read", "fs.write", "child", "worker"]) {
      if (process.permission.has(scope)) {
        throw new Error("forbidden-permission-enabled:" + scope);
      }
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!payload || typeof payload.code !== "string") {
      throw new Error("invalid-codeact-payload");
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction("input", '"use strict";\n' + payload.code);
    const output = await execute(payload.input);
    process.stdout.write(JSON.stringify({ ok: true, output }));
  } catch (error) {
    fail(error);
  }
});

function fail(error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
`;
