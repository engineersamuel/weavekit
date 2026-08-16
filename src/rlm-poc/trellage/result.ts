import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Directory holding delegated-run result files, relative to the worktree root.
 *
 * It must be *relative*: container profiles bind-mount the worktree at `/mounts/<name>`, so an
 * absolute host path is meaningless inside the harness. `.weavekit/` is gitignored, so result files
 * do not dirty the worktree and the "was this worktree touched?" check stays honest.
 */
export const TRELLAGE_RESULT_DIRECTORY = ".weavekit/rlm-trellage";

export type TrellageResultLocation = {
  /** Path the harness is told to write, relative to whatever it sees as the repository root. */
  relativePath: string;
  /** Host path the tool reads. */
  absolutePath: string;
  relativeDirectory: string;
  absoluteDirectory: string;
  /** Path the harness is told to read its task from, relative to its repository root. */
  taskRelativePath: string;
  /** Host path the tool writes the task document to. */
  taskAbsolutePath: string;
};

export function resolveResultLocation(
  worktreePath: string,
  runId: string,
  callId: string,
): TrellageResultLocation {
  const relativeDirectory = `${TRELLAGE_RESULT_DIRECTORY}/${runId}/${callId}`;
  const relativePath = `${relativeDirectory}/result.md`;
  const taskRelativePath = `${relativeDirectory}/task.md`;
  return {
    relativePath,
    relativeDirectory,
    absolutePath: join(worktreePath, relativePath),
    absoluteDirectory: join(worktreePath, relativeDirectory),
    taskRelativePath,
    taskAbsolutePath: join(worktreePath, taskRelativePath),
  };
}

export async function prepareResultLocation(location: TrellageResultLocation): Promise<void> {
  await mkdir(location.absoluteDirectory, { recursive: true });
  // A stale file from a reused call ID would be read as this invocation's answer.
  await rm(location.absolutePath, { force: true });
}

/**
 * Hands the task to the harness as a file and returns the one-line prompt that points at it.
 *
 * The prompt has to be a single line. TUI harnesses treat multi-line input as a paste: Copilot CLI
 * collapses it to a `[Paste #1 - 14 lines]` block that needs a second Enter it does not reliably
 * accept, and other harnesses bind Enter to "newline" inside a multi-line buffer — either way the
 * turn silently never starts, and the untouched screen is indistinguishable from a question. A file
 * keeps the full instructions intact while the terminal only ever sees one short line.
 */
export async function writeTaskDocument(
  location: TrellageResultLocation,
  prompt: string,
): Promise<string> {
  await writeFile(location.taskAbsolutePath, buildDelegatedPrompt(prompt, location), "utf8");
  return (
    `Read the file ${location.taskRelativePath} (relative to this repository's root) ` +
    "and carry out the task described in it, following its reporting instructions exactly."
  );
}

/**
 * Flattens text typed into a harness's composer to a single line.
 *
 * Same reason as `writeTaskDocument`: anything with a newline in it risks becoming an unsubmitted
 * paste block instead of a message.
 */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export async function readResult(location: TrellageResultLocation): Promise<string | undefined> {
  try {
    const text = await readFile(location.absolutePath, "utf8");
    return text.trim().length > 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps the caller's task with the result-file contract.
 *
 * The file is the completion oracle for the whole drive loop. Herdr's lifecycle state only says
 * *when to look*: `idle` means "accepting input", which a finished agent and an agent waiting on a
 * prose question both report. Its presence is the only reliable proof the delegated turn finished,
 * and it is also the only complete transcript available, because harnesses that render on the
 * terminal's alternate screen lose their output to scrollback where `agent.read` cannot reach it.
 */
export function buildDelegatedPrompt(prompt: string, location: TrellageResultLocation): string {
  return [
    prompt,
    "",
    "---",
    "",
    "## How to report your result",
    "",
    "You are running unattended on behalf of another agent. Nobody is reading your terminal.",
    "You are the delegated worker, not the orchestrator.",
    "You do not have the `invoke_trellage` tool in this session.",
    "Do not instruct anyone to call `invoke_trellage`, and do not claim you can delegate further.",
    "",
    `1. When the task above is complete, write your entire final answer as Markdown to the file \`${location.relativePath}\`, resolved relative to the root of the repository you are working in.`,
    "2. Write that file only once, and only when you are finished. Its existence is how the caller detects that you are done, so do not create it early or as a placeholder.",
    "3. Include everything the caller needs: findings, decisions, file paths you changed, and anything you could not complete. The caller sees this file and nothing else.",
    `4. After writing it, reply in the terminal with exactly \`${location.relativePath}\` and nothing else.`,
    "",
    "If you need information you do not have, ask in the terminal instead of writing the file; the caller is watching and will answer.",
  ].join("\n");
}
