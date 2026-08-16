import { spawn } from "node:child_process";

const TERMINATION_GRACE_MS = 1_000;

export type TrellageProcessInput = {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type TrellageProcessResult = {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
};

export type TrellageProcessRunner = {
  run(input: TrellageProcessInput): Promise<TrellageProcessResult>;
};

/**
 * Runs one launcher without a shell or PTY. It records both streams and always terminates only the
 * spawned child when a timeout or cancellation occurs.
 */
export const nativeTrellageProcessRunner: TrellageProcessRunner = {
  async run(input: TrellageProcessInput): Promise<TrellageProcessResult> {
    const [command, ...args] = input.argv;
    if (!command) throw new Error("A headless Trellage command requires an executable.");

    return new Promise<TrellageProcessResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const child = spawn(command, args, {
        cwd: input.cwd,
        // A detached Unix child begins its own process group. This lets a bounded attempt clean
        // up grandchildren that inherited the launcher's stdout/stderr pipes.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): TrellageProcessResult => ({
        argv: [...input.argv],
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        cancelled,
      });
      const sendSignal = (signal: NodeJS.Signals) => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          if (process.platform !== "win32") {
            process.kill(-pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // The group may have already exited. Do not mask the original timeout/cancellation.
        }
      };
      let forceKill: NodeJS.Timeout | undefined;
      const terminate = (reason: "timeout" | "cancelled") => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        if (reason === "timeout") timedOut = true;
        else cancelled = true;
        sendSignal("SIGTERM");
        forceKill = setTimeout(() => {
          if (!settled) sendSignal("SIGKILL");
        }, TERMINATION_GRACE_MS);
      };
      const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
      const onAbort = () => terminate("cancelled");

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        input.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(finish(exitCode, signal));
      });
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
