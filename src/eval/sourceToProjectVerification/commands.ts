import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export type PlanCommandInvocation = {
  command: string;
  args: string[];
  cwd: string;
};

export type BuildCopilotPlanInvocationArgs = {
  workspaceDir: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
};

export type BuildCodexPlanInvocationArgs = BuildCopilotPlanInvocationArgs & {
  outputPath: string;
};

export type PlanCommandRunner = (
  invocation: PlanCommandInvocation,
  options?: { timeoutMs?: number; outputPath?: string },
) => Promise<string>;

export function buildCopilotPlanInvocation(
  args: BuildCopilotPlanInvocationArgs,
): PlanCommandInvocation {
  return {
    command: "copilot",
    cwd: args.workspaceDir,
    args: [
      "--plan",
      "--available-tools=view,rg,glob",
      "--allow-all-tools",
      "--deny-tool=write",
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-ask-user",
      "--disallow-temp-dir",
      "--silent",
      "--no-color",
      "--stream",
      "off",
      "--model",
      args.model,
      "--effort",
      args.reasoningEffort,
      "-C",
      args.workspaceDir,
      "-p",
      args.prompt,
    ],
  };
}

export function buildCodexPlanInvocation(
  args: BuildCodexPlanInvocationArgs,
): PlanCommandInvocation {
  return {
    command: "codex",
    cwd: args.workspaceDir,
    args: [
      "exec",
      "--ephemeral",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "-c",
      `model_reasoning_effort="${args.reasoningEffort}"`,
      "-C",
      args.workspaceDir,
      "-o",
      args.outputPath,
      "-m",
      args.model,
      args.prompt,
    ],
  };
}

export const runPlanCommand: PlanCommandRunner = async (invocation, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 900_000;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${invocation.command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`${invocation.command} exited ${code}: ${stderr.trim() || stdout.trim()}`),
        );
        return;
      }
      try {
        const output = options.outputPath ? await readFile(options.outputPath, "utf8") : stdout;
        if (!output.trim()) {
          reject(new Error(`${invocation.command} returned an empty plan.`));
          return;
        }
        resolve(output);
      } catch (error) {
        reject(error);
      }
    });
  });
};
