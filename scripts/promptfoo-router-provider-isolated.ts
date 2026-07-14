import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ApiProvider, ProviderResponse } from "promptfoo";
import type { ProviderOptions } from "./promptfoo-router-provider.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerPath = fileURLToPath(new URL("./promptfoo-router-provider-runner.ts", import.meta.url));

type ProviderCallContext = Parameters<ApiProvider["callApi"]>[1];

type IsolatedProviderInput = {
  options: ProviderOptions;
  prompt: string;
  vars?: NonNullable<ProviderCallContext>["vars"];
};

export default class IsolatedPromptfooRouterProvider implements ApiProvider {
  public readonly config: ProviderOptions["config"];
  private readonly options: ProviderOptions;
  private readonly providerId: string;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
    this.config = options.config ?? {};
    const mode = this.config.mode ?? "deterministic";
    this.providerId =
      options.id ?? (mode === "gpt-5-mini" ? "router-gpt-5-mini" : "router-deterministic");
  }

  id(): string {
    return this.providerId;
  }

  callApi(
    prompt: string,
    context?: Parameters<ApiProvider["callApi"]>[1],
  ): Promise<ProviderResponse> {
    return runIsolatedProvider({
      options: this.options,
      prompt,
      vars: context?.vars,
    });
  }
}

function runIsolatedProvider(input: IsolatedProviderInput): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    const marker = `__WEAVEKIT_ROUTER_RESULT_${randomUUID()}__`;
    const child = spawn(process.env.NUB_BIN ?? "nub", [runnerPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        WEAVEKIT_ROUTER_RESULT_MARKER: marker,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Isolated router provider timed out after 300000ms.")));
    }, 300_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(
            new Error(
              `Isolated router provider exited with code ${String(code)}: ${stderr.trim()}`,
            ),
          );
          return;
        }
        const markerIndex = stdout.lastIndexOf(marker);
        if (markerIndex < 0) {
          reject(
            new Error(
              `Isolated router provider returned no result marker. stderr: ${stderr.trim()}`,
            ),
          );
          return;
        }
        const payload = stdout.slice(markerIndex + marker.length).trim();
        try {
          resolve(JSON.parse(payload) as ProviderResponse);
        } catch (error) {
          reject(
            new Error(
              `Isolated router provider returned invalid JSON: ${(error as Error).message}`,
            ),
          );
        }
      });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
