import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiProvider, ProviderResponse } from "promptfoo";

export interface CopilotProviderOptions {
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}

export class CopilotCliProvider implements ApiProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: typeof spawn;

  constructor(options: CopilotProviderOptions = {}) {
    this.model = options.model ?? process.env.EVAL_COPILOT_MODEL ?? "auto";
    this.timeoutMs = options.timeoutMs ?? Number(process.env.EVAL_COPILOT_TIMEOUT_MS ?? 180_000);
    this.spawnFn = options.spawnFn ?? spawn;
  }

  id(): string {
    return "copilot-cli:vanilla";
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const cwd = await mkdtemp(join(tmpdir(), "weavekit-eval-copilot-"));
    try {
      const output = await this.invoke(prompt, cwd);
      return { output };
    } catch (error) {
      return { error: `copilot-cli failed: ${(error as Error).message}` };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private invoke(prompt: string, cwd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnFn(
        "copilot",
        ["-p", prompt, "--allow-all", "--no-color", "--model", this.model, "-C", cwd],
        { cwd, env: process.env },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`exit ${code}: ${stderr.trim() || stdout.trim()}`));
        }
      });
    });
  }
}
