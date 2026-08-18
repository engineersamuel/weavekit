#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { RLM_CLI_USAGE, parseRlmCliArgs, type RlmCliOptions } from "../src/rlm-poc/cli.js";
import { loadRlmEnvironment, writeRlmOutput } from "../src/rlm-poc/environment.js";
import { buildRlmResumeReceipt, buildTrellageWorktreeReceipt } from "../src/rlm-poc/output.js";
import type { RlmPrototypeResult } from "../src/rlm-poc/runtime.js";

/**
 * CLI entry point for the `rlm` prototype (ADR 0010). Without arguments, runs the movie/book/color
 * validation scenario end to end.
 *
 * With `-p/--prompt` (or `--prompt-file`), runs the general recursive Submind path instead so a
 * caller can observe how an arbitrary prompt selects profiles and flows through the recursive
 * tool.
 */
async function main(): Promise<void> {
  const options = parseRlmCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(RLM_CLI_USAGE);
    return;
  }

  const prompt = options.promptFile
    ? (await readFile(options.promptFile, "utf8")).trim()
    : options.prompt;
  if (options.promptFile && prompt!.length === 0) {
    throw new Error(`The --prompt-file at "${options.promptFile}" is empty.`);
  }

  await loadRlmEnvironment();
  const [{ shutdownTelemetry }, { startTelemetry }, { runRlmPrototype, runRlmSubmind }] =
    await Promise.all([
      import("../src/submind-poc/telemetry.js"),
      import("../src/telemetry/bootstrap.js"),
      import("../src/rlm-poc/runtime.js"),
    ]);
  const telemetry = await startTelemetry("weavekit-rlm-poc", {
    skipWhenUnconfigured: true,
  });
  try {
    const result = prompt
      ? await runRlmSubmind(prompt, {
          ...(options.resume ? { conversationId: options.resume } : {}),
          ...(options.trellage ? { enableTrellage: true } : {}),
          ...(options.eagerWorktree ? { provisionTrellageWorktreeEagerly: true } : {}),
          ...(options.reuseCurrentWorktree ? { reuseCurrentTrellageWorktree: true } : {}),
          ...(options.cwd ? { workingDirectory: options.cwd } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.maxDepth ? { maxDepth: options.maxDepth } : {}),
          ...(options.maxTotalCalls ? { maxTotalCalls: options.maxTotalCalls } : {}),
          ...(options.acceptanceCriteria || options.constraints || options.validationCommands
            ? {
                runBrief: {
                  ...(options.acceptanceCriteria
                    ? { acceptanceCriteria: options.acceptanceCriteria }
                    : {}),
                  ...(options.constraints ? { constraints: options.constraints } : {}),
                  ...(options.validationCommands
                    ? { validationCommands: options.validationCommands }
                    : {}),
                },
              }
            : {}),
        })
      : await runRlmPrototype();
    await writeOutputJson(options, { ok: true, result });
    writeRlmOutput(`${result.finalText}\n`);
    if (result.worktrees?.length) {
      writeRlmOutput(buildTrellageWorktreeReceipt(result.worktrees));
    }
    if (prompt) {
      if (!result.conversationId) {
        throw new Error("General Submind run completed without a conversation ID.");
      }
      writeRlmOutput(buildRlmResumeReceipt(result.conversationId, result.traceId));
    }
  } catch (error) {
    await writeOutputJson(options, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await shutdownTelemetry(telemetry);
  }
}

/**
 * Writes the run's raw outcome to `--output-json`, if set, the instant the call resolves (success
 * or failure). This is the literal `RlmPrototypeResult` the SDK call returned (or the failure
 * message), captured to disk so an out-of-process caller (e.g. Mastermind's `RlmDirectExecutor`)
 * polling this detached process from the outside can read Submind's final output back.
 */
async function writeOutputJson(
  options: RlmCliOptions,
  payload: { ok: true; result: RlmPrototypeResult } | { ok: false; error: string },
): Promise<void> {
  if (!options.outputJsonPath) {
    return;
  }
  await writeFile(
    options.outputJsonPath,
    `${JSON.stringify({ ...payload, observedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
