import { spawn } from "node:child_process";
import path from "node:path";
import { Trace } from "./trace.js";
import type { ApprovalGate, ApprovalRequest } from "./approval.js";

export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };

const DANGEROUS_EXECUTABLES = new Set(["dd", "rm", "sudo"]);
const SAFE_EXECUTABLE = /^[a-zA-Z0-9._-]+$/u;

export class ConfinedShell {
  private readonly workspaceRoot: string;
  private readonly approval: ApprovalGate;
  private readonly trace: Trace;

  constructor(workspaceRoot: string, approval: ApprovalGate, trace: Trace) {
    this.workspaceRoot = workspaceRoot;
    this.approval = approval;
    this.trace = trace;
  }

  private resolveCwd(subdirectory?: string): string {
    const base = path.resolve(this.workspaceRoot);
    const candidate = subdirectory ? path.resolve(base, subdirectory) : base;
    const relative = path.relative(base, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("cwd outside workspace");
    }
    return candidate;
  }

  private validate(command: string, args: string[]): void {
    if (!SAFE_EXECUTABLE.test(command) || DANGEROUS_EXECUTABLES.has(command)) {
      throw new Error(`forbidden executable: ${command}`);
    }
    for (const arg of args) {
      if (arg.includes("\u0000") || arg.includes("\n") || arg.includes("\r")) {
        throw new Error("forbidden control character in argument");
      }
      if (
        path.isAbsolute(arg) ||
        arg === ".." ||
        arg.startsWith(`..${path.sep}`) ||
        arg.includes(`${path.sep}..${path.sep}`)
      ) {
        throw new Error("forbidden absolute path or traversal");
      }
    }
  }

  async exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult> {
    const cwd = this.resolveCwd(opts?.cwd);
    this.validate(cmd, args);

    const request: ApprovalRequest = {
      actor: "harness",
      action: "exec",
      details: { cmd, args, opts, cwd },
    };
    const allowed = await this.approval.requestApproval(request);
    this.trace.push("shell.exec.requested", cmd, { allowed, cwd, argCount: args.length });
    if (!allowed) {
      this.trace.push("shell.exec.denied", `denied ${cmd}`);
      throw new Error("action denied by approval gate");
    }

    this.trace.push("shell.exec.start", `running ${cmd}`, { cwd, args });
    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let finished = false;
      let timer: NodeJS.Timeout | undefined;

      const clearTimer = () => {
        if (timer) clearTimeout(timer);
      };
      const onFinish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimer();
        this.trace.push("shell.exec.end", `finished ${cmd}`, { code });
        resolve({ stdout, stderr, code, timedOut: false });
      };
      child.stdout.on("data", (b) => (stdout += b.toString()));
      child.stderr.on("data", (b) => (stderr += b.toString()));
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimer();
        reject(err);
      });
      child.on("close", onFinish);

      if (opts?.timeoutMs) {
        timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            child.kill("SIGKILL");
            this.trace.push("shell.exec.timeout", `killed ${cmd}`);
            resolve({ stdout, stderr, code: null, timedOut: true });
          }
        }, opts.timeoutMs);
      }
    });
  }
}
