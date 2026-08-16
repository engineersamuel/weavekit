import { MastermindHarnessTransport, type MastermindHarnessProfile } from "../../config.js";
import type {
  LinearTicketInput,
  PostImplementationReviewDossier,
} from "../../generated/baml_client/index.js";
import { buildCopilotClientConnectionOptions } from "../../telemetry/copilotSdk.js";
import { runConfiguredHarnessCommand } from "../harness/command.js";
import { createReviewPermissionHandler, extractJsonObject } from "../review/harness.js";
import type { ExecutionAttempt, StoredReview } from "../store/store.js";

// NOTE: the SDK's built-in command-execution tool is named "bash", not "shell" — "shell" is only
// the permission-request kind for it (see createReviewPermissionHandler's `case "shell"`).
const CODE_REVIEW_TOOLS = ["read_file", "list_dir", "grep", "glob", "bash"] as const;

export type CodeReviewHarnessRequest = {
  ticket: LinearTicketInput;
  ticketReview: StoredReview;
  attempt: ExecutionAttempt;
};

export type CodeReviewHarness = {
  review(request: CodeReviewHarnessRequest): Promise<PostImplementationReviewDossier>;
};

type ReviewClient = {
  start(): Promise<void>;
  createSession(config: unknown): Promise<{
    sendAndWait(
      message: { prompt: string },
      timeout?: number,
    ): Promise<{ data?: { content?: string } } | undefined>;
    disconnect(): Promise<void>;
  }>;
  stop(): Promise<Error[] | undefined>;
};

export class CopilotSdkCodeReviewHarness implements CodeReviewHarness {
  constructor(
    private readonly profile: MastermindHarnessProfile,
    private readonly clientFactory: (cwd: string) => Promise<ReviewClient> = async (cwd) => {
      const { CopilotClient } = await import("@github/copilot-sdk");
      const Client = CopilotClient as unknown as new (options?: unknown) => ReviewClient;
      return new Client({
        ...(await buildCopilotClientConnectionOptions(profile.command, profile.args)),
        workingDirectory: cwd,
      });
    },
  ) {}

  async review(request: CodeReviewHarnessRequest): Promise<PostImplementationReviewDossier> {
    const worktree = requireWorktree(request.attempt);
    const client = await this.clientFactory(worktree);
    await client.start();
    let session: Awaited<ReturnType<ReviewClient["createSession"]>> | undefined;
    try {
      session = await client.createSession({
        model: this.profile.model,
        streaming: false,
        workingDirectory: worktree,
        availableTools: [...CODE_REVIEW_TOOLS],
        onPermissionRequest: createReviewPermissionHandler({ mode: "repository" }),
      });
      const response = await session.sendAndWait(
        { prompt: buildCodeReviewPrompt(request) },
        10 * 60_000,
      );
      const content = response?.data?.content ?? "";
      try {
        return parseCodeReviewDossier(content);
      } catch (firstError) {
        const correction = await session.sendAndWait(
          {
            prompt: `Your previous response did not satisfy the required JSON contract: ${formatError(
              firstError,
            )}. Return the same review again as one JSON object only. Do not include prose or Markdown fences.`,
          },
          2 * 60_000,
        );
        try {
          return parseCodeReviewDossier(correction?.data?.content ?? "");
        } catch (retryError) {
          throw new Error(
            `Code-review harness returned invalid structured output after one correction: ${formatError(
              retryError,
            )}`,
          );
        }
      }
    } finally {
      await session?.disconnect();
      await client.stop();
    }
  }
}

export class CommandCodeReviewHarness implements CodeReviewHarness {
  constructor(private readonly profile: MastermindHarnessProfile) {}

  async review(request: CodeReviewHarnessRequest): Promise<PostImplementationReviewDossier> {
    const prompt = buildCodeReviewPrompt(request);
    const args = interpolatePromptArgs(this.profile.args, prompt);
    const stdout = await runConfiguredHarnessCommand({
      command: this.profile.command,
      args,
      cwd: requireWorktree(request.attempt),
    });
    return parseCodeReviewDossier(stdout);
  }
}

export function createCodeReviewHarness(profile: MastermindHarnessProfile): CodeReviewHarness {
  if (profile.transport === MastermindHarnessTransport.COMMAND) {
    return new CommandCodeReviewHarness(profile);
  }
  if (profile.transport !== MastermindHarnessTransport.COPILOT_SDK) {
    throw new Error(`Code-review harness transport is unsupported: ${profile.transport}`);
  }
  return new CopilotSdkCodeReviewHarness(profile);
}

export function buildCodeReviewPrompt(request: CodeReviewHarnessRequest): string {
  const worktree = requireWorktree(request.attempt);
  return `Perform an independent post-implementation code review in the current worktree.
This is not ticket-readiness review. Do not edit files, run destructive commands, mutate Linear,
or change requirements. Inspect the implementation, tests, git history/diff, and result evidence.

Canonical review worktree: ${worktree}
Run pwd first and verify it equals that exact path. Inspect artifacts only in that checkout. Do not
substitute the parent source repository, provisioning root, another worktree, or ~/projects. Include
untracked files in the review because a greenfield result can exist before its first implementation
commit. If the current directory does not equal the canonical path, return an unanswered question
that reports the observed path instead of reviewing a different directory.

Frozen reviewed ticket:
${JSON.stringify(request.ticket, null, 2)}

Ticket-readiness review:
${JSON.stringify(request.ticketReview.patch, null, 2)}

Successful execution result:
${JSON.stringify(request.attempt.result, null, 2)}

Independent verification:
${JSON.stringify(request.attempt.verification, null, 2)}

Every manualVerification entry must be a self-contained step a human can paste into a terminal with
no prior context. Give the absolute path of every script, file, and directory the step names — the
canonical worktree path above is the root — plus the exact command and the output and exit code that
prove the step passed. Never write "from the worktree root", "in the project directory", or another
relative reference without also giving the absolute path. Order the entries so that following them
from top to bottom reproduces the verification.

Return JSON only:
{
  "summary": "string",
  "acceptanceCriteriaCoverage": ["criterion plus concrete evidence"],
  "verificationAssessment": ["string"],
  "manualVerification": ["self-contained step: absolute paths, exact command, expected output and exit code"],
  "findings": [
    {
      "severity": "BLOCKING | IMPORTANT | SUGGESTION",
      "summary": "string",
      "evidence": ["repository-relative path/symbol or observed behavior"],
      "remediation": "optional string"
    }
  ],
  "knownRisks": ["string"],
  "unansweredQuestions": ["human-owned question only"],
  "confidence": 0.0
}`;
}

export function parseCodeReviewDossier(content: string): PostImplementationReviewDossier {
  const value = JSON.parse(extractJsonObject(content)) as PostImplementationReviewDossier;
  if (
    !value ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.acceptanceCriteriaCoverage) ||
    !Array.isArray(value.findings) ||
    typeof value.confidence !== "number"
  ) {
    throw new Error("Code-review harness returned an invalid dossier.");
  }
  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reviewWorktreePath(attempt: ExecutionAttempt): string | undefined {
  return attempt.executorHandle?.worktreePath ?? attempt.workspace?.checkoutPath;
}

function requireWorktree(attempt: ExecutionAttempt): string {
  const path = reviewWorktreePath(attempt);
  if (!path) throw new Error("Successful execution has no reviewable worktree.");
  return path;
}

function interpolatePromptArgs(args: string[], prompt: string): string[] {
  return args.some((arg) => arg.includes("{prompt}"))
    ? args.map((arg) => arg.replaceAll("{prompt}", prompt))
    : [...args, prompt];
}
