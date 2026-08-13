import { execFile } from "node:child_process";
import { cp, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WeavekitConfig } from "../../config.js";
import { MastermindEventType, MastermindState } from "../domain/events.js";
import { transitionMastermindState } from "../domain/machine.js";
import type { LinearGateway } from "../linear/client.js";
import type {
  ExecutionAttachmentTarget,
  MastermindStore,
  MastermindWorkItem,
} from "../store/store.js";

type AcceptanceStore = Pick<
  MastermindStore,
  "acquireLease" | "findExecutionAttachment" | "getWork" | "releaseLease" | "transition"
>;

const execFileAsync = promisify(execFile);

export async function acceptMastermindWork(input: {
  selector: string;
  config: WeavekitConfig;
  store: AcceptanceStore;
  linear: LinearGateway;
}): Promise<MastermindWorkItem> {
  const selector = input.selector.trim();
  if (!selector) {
    throw new Error(
      "Usage: mise run mastermind:accept <ticket-identifier|work-id|issue-id|attempt-id>",
    );
  }
  const target = await input.store.findExecutionAttachment(selector);
  if (!target) throw new Error(`No Mastermind execution found for: ${selector}`);
  const owner = input.config.mastermind.instanceId;
  const leased = await input.store.acquireLease(
    target.workId,
    owner,
    new Date(),
    input.config.mastermind.leaseDurationMs,
  );
  if (!leased) throw new Error(`Mastermind work ${target.workId} is currently leased.`);
  try {
    const work = await input.store.getWork(target.workId);
    if (!work) throw new Error(`Mastermind work ${target.workId} disappeared.`);
    if (
      work.state !== MastermindState.AWAITING_ACCEPTANCE &&
      work.state !== MastermindState.COMPLETED
    ) {
      throw new Error(
        `Mastermind work ${target.workId} cannot be accepted from state ${work.state}.`,
      );
    }
    await persistAcceptedWorkspace(target);
    if (work.state === MastermindState.COMPLETED) {
      await upsertAcceptanceComment(input.linear, work, target);
      return work;
    }
    if (!input.linear.setIssueState) {
      throw new Error("Linear gateway does not support workflow-state projection.");
    }
    await input.linear.setIssueState(work.issueId, input.config.mastermind.doneStateName ?? "Done");
    await input.linear.replaceIssueLabels(work.issueId, {
      remove: [
        input.config.mastermind.codeReviewLabelId ?? "",
        input.config.mastermind.codeReviewPassedLabelId ?? "",
        input.config.mastermind.changesRequestedLabelId ?? "",
      ].filter(Boolean),
      add: [],
    });
    await upsertAcceptanceComment(input.linear, work, target);
    return input.store.transition(work, owner, {
      eventType: MastermindEventType.ACCEPT_IMPLEMENTATION,
      priorState: work.state,
      nextState: transitionMastermindState(work.state, {
        type: MastermindEventType.ACCEPT_IMPLEMENTATION,
      }),
    });
  } finally {
    await input.store.releaseLease(target.workId, owner);
  }
}

async function upsertAcceptanceComment(
  linear: LinearGateway,
  work: MastermindWorkItem,
  target: ExecutionAttachmentTarget,
): Promise<void> {
  if (!linear.findIssueCommentByMarker || !linear.createIssueComment) return;
  const marker = `<!-- weavekit-mastermind-acceptance:${work.id} -->`;
  const body = buildAcceptanceComment(marker, target);
  const existing = await linear.findIssueCommentByMarker(work.issueId, marker);
  if (existing) {
    await linear.updateIssueComment?.(existing, body);
    return;
  }
  await linear.createIssueComment(work.issueId, body);
}

export function buildAcceptanceComment(marker: string, target: ExecutionAttachmentTarget): string {
  const checkoutPath = durableWorkspacePath(target);
  const result = target.attempt.result;
  const artifactPaths = result?.artifactPaths ?? [];
  const documentationPaths = artifactPaths.filter(
    (path) => path === "README.md" || (path.startsWith("docs/") && path.endsWith(".md")),
  );
  const lines = [
    marker,
    "Mastermind implementation accepted. Ticket moved to **Done**.",
    "",
    "## Work location",
    "",
    `Canonical implementation worktree: \`${checkoutPath}\``,
    "",
    "```bash",
    `cd ${shellQuote(checkoutPath)}`,
    "pwd",
    "git status --short",
    "```",
  ];
  if (documentationPaths.length > 0) {
    lines.push(
      "",
      "## Start here",
      "",
      ...documentationPaths.map((path) => `- Read [\`${path}\`](file://${checkoutPath}/${path})`),
      "",
      "```bash",
      ...documentationPaths.map((path) => `sed -n '1,240p' ${shellQuote(path)}`),
      "```",
    );
  }
  if (artifactPaths.length > 0) {
    lines.push("", "## Produced artifacts", "", ...artifactPaths.map((path) => `- \`${path}\``));
  }
  if (result?.verification.length) {
    lines.push(
      "",
      "## Validation commands used",
      "",
      "These commands produced the accepted evidence. Review each command before rerunning it; deployment or cleanup commands can change external resources.",
      "",
      ...result.verification.flatMap((entry) => [
        "```bash",
        entry.command,
        "```",
        `Result: exit ${entry.exitCode} — ${entry.summary}`,
        "",
      ]),
    );
  }
  lines.push(
    "## Inspect all delivered files",
    "",
    "```bash",
    "find . -maxdepth 3 -type f -not -path './.git/*' | sort",
    "```",
  );
  return lines.join("\n");
}

export async function persistAcceptedWorkspace(target: ExecutionAttachmentTarget): Promise<void> {
  const workspace = target.attempt.workspace;
  if (!workspace || workspace.kind !== "greenfield-repository-worktree") return;
  const checkoutPath = await realpath(workspace.checkoutPath);
  const sourceRepositoryPath = await realpath(workspace.sourceRepositoryPath);
  if (checkoutPath === sourceRepositoryPath) return;
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: checkoutPath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  for (const repositoryPath of stdout.split("\0").filter(Boolean)) {
    if (repositoryPath.startsWith(".weavekit/")) continue;
    const source = containedArtifactPath(checkoutPath, repositoryPath);
    const destination = containedArtifactPath(sourceRepositoryPath, repositoryPath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  }
  for (const artifactPath of target.attempt.result?.artifactPaths ?? []) {
    if (!artifactPath.startsWith(".weavekit/")) continue;
    const source = containedArtifactPath(checkoutPath, artifactPath);
    const destination = containedArtifactPath(sourceRepositoryPath, artifactPath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  }
}

function durableWorkspacePath(target: ExecutionAttachmentTarget): string {
  const workspace = target.attempt.workspace;
  const path =
    workspace?.kind === "greenfield-repository-worktree"
      ? workspace.sourceRepositoryPath
      : (workspace?.checkoutPath ?? target.attempt.executorHandle?.worktreePath);
  if (!path) {
    throw new Error(`Mastermind attempt ${target.attempt.id} has no recorded checkout path.`);
  }
  return path;
}

function containedArtifactPath(root: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) {
    throw new Error(`Mastermind artifact path must be relative: ${artifactPath}`);
  }
  const path = resolve(root, artifactPath);
  const relation = relative(root, path);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`Mastermind artifact path escapes its workspace: ${artifactPath}`);
  }
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
