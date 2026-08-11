import { MastermindHarnessTransport, type MastermindHarnessProfile } from "../../config.js";
import type {
  LinearTicketInput,
  PostImplementationReviewDossier,
} from "../../generated/baml_client/index.js";
import { buildCopilotClientOptions } from "../../telemetry/copilotSdk.js";
import { runConfiguredHarnessCommand } from "../harness/command.js";
import { createReviewPermissionHandler } from "../review/harness.js";
import type { ExecutionAttempt, StoredReview } from "../store/store.js";

const CODE_REVIEW_TOOLS = ["read_file", "list_dir", "grep", "glob", "shell"] as const;

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
        ...buildCopilotClientOptions(),
        cwd,
        cliPath: profile.command,
        cliArgs: profile.args,
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
        availableTools: [...CODE_REVIEW_TOOLS],
        onPermissionRequest: createReviewPermissionHandler({ mode: "repository" }),
      });
      const response = await session.sendAndWait(
        { prompt: buildCodeReviewPrompt(request) },
        10 * 60_000,
      );
      return parseCodeReviewDossier(response?.data?.content ?? "");
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
  return `Perform an independent post-implementation code review in the current worktree.
This is not ticket-readiness review. Do not edit files, run destructive commands, mutate Linear,
or change requirements. Inspect the implementation, tests, git history/diff, and result evidence.

Frozen reviewed ticket:
${JSON.stringify(request.ticket, null, 2)}

Ticket-readiness review:
${JSON.stringify(request.ticketReview.patch, null, 2)}

Successful execution result:
${JSON.stringify(request.attempt.result, null, 2)}

Independent verification:
${JSON.stringify(request.attempt.verification, null, 2)}

Return JSON only:
{
  "summary": "string",
  "acceptanceCriteriaCoverage": ["criterion plus concrete evidence"],
  "verificationAssessment": ["string"],
  "manualVerification": ["specific step"],
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

function parseCodeReviewDossier(content: string): PostImplementationReviewDossier {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  const value = JSON.parse(trimmed) as PostImplementationReviewDossier;
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

function requireWorktree(attempt: ExecutionAttempt): string {
  const path = attempt.executorHandle?.worktreePath ?? attempt.workspace?.checkoutPath;
  if (!path) throw new Error("Successful execution has no reviewable worktree.");
  return path;
}

function interpolatePromptArgs(args: string[], prompt: string): string[] {
  return args.some((arg) => arg.includes("{prompt}"))
    ? args.map((arg) => arg.replaceAll("{prompt}", prompt))
    : [...args, prompt];
}
