import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { WorkQueueBackendError, type WorkQueueBackend } from "./backend.js";
import {
  CompleteWorkItemInputSchema,
  CreateWorkItemInputSchema,
  ReadyWorkFilterSchema,
  WorkDependencyTypeSchema,
  WorkItemSchema,
  WorkItemStatusSchema,
  WorkItemTypeSchema,
  type CompleteWorkItemInput,
  type CreateWorkItemInput,
  type ReadyWorkFilter,
  type WorkItem,
} from "./schema.js";

const execFileAsync = promisify(execFile);

// Beads emits `issue_type` instead of `type` and `dependency_type` instead of `type` in deps.
const BeadsRawDepSchema = z.object({
  dependency_type: WorkDependencyTypeSchema.optional(),
  type: WorkDependencyTypeSchema.optional(),
  id: z.string().min(1),
});

const BeadsRawIssueSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  status: WorkItemStatusSchema,
  issue_type: WorkItemTypeSchema.optional(),
  type: WorkItemTypeSchema.optional(),
  priority: z.number().int().min(0).max(4),
  assignee: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).default([]),
  dependencies: z.array(BeadsRawDepSchema).default([]),
});

function normalizeBeadsIssue(raw: z.infer<typeof BeadsRawIssueSchema>): WorkItem {
  return WorkItemSchema.parse({
    id: raw.id,
    title: raw.title,
    description: raw.description,
    status: raw.status,
    type: raw.issue_type ?? raw.type,
    priority: raw.priority,
    assignee: raw.assignee,
    labels: raw.labels,
    dependencies: raw.dependencies.map((d) => ({
      type: d.dependency_type ?? d.type,
      id: d.id,
    })),
  });
}

export type BeadsCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type BeadsCommandRunner = (
  bin: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<BeadsCommandResult>;

export type BeadsCliWorkQueueOptions = {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  runCommand?: BeadsCommandRunner;
};

type NodeExecError = NodeJS.ErrnoException & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
};

export function normalizeRunnerError(args: string[], error: unknown): never {
  const nodeError = error as NodeExecError;
  // child_process sets code to the numeric exit code on non-zero exit,
  // but to a string like "ENOENT" for OS-level failures (missing binary, etc.)
  const exitCode = typeof nodeError.code === "number" ? nodeError.code : 1;
  const causeCode = typeof nodeError.code === "string" ? nodeError.code : undefined;
  throw new WorkQueueBackendError(`bd ${args[0] ?? ""} failed with exit code ${exitCode}`, {
    args,
    exitCode,
    stdout: nodeError.stdout ?? "",
    stderr: nodeError.stderr ?? nodeError.message,
    ...(causeCode !== undefined ? { causeCode } : {}),
  });
}

const defaultRunner: BeadsCommandRunner = async (bin, args, options) => {
  try {
    const result = await execFileAsync(bin, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });

    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    normalizeRunnerError(args, error);
  }
};

function parseJson(command: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new WorkQueueBackendError(`bd ${command} returned invalid JSON`, { stdout, error });
  }
}

function parseWorkItem(command: string, stdout: string): WorkItem {
  const raw = parseJson(command, stdout);
  const candidate =
    typeof raw === "object" && raw !== null && "issue" in raw
      ? (raw as { issue: unknown }).issue
      : raw;
  return normalizeBeadsIssue(BeadsRawIssueSchema.parse(candidate));
}

function parseWorkItemList(command: string, stdout: string): WorkItem[] {
  const raw = parseJson(command, stdout);
  const candidate =
    typeof raw === "object" && raw !== null && "items" in raw
      ? (raw as { items: unknown }).items
      : raw;
  return z.array(BeadsRawIssueSchema).parse(candidate).map(normalizeBeadsIssue);
}

export class BeadsCliWorkQueue implements WorkQueueBackend {
  private readonly cwd: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly runCommand: BeadsCommandRunner;

  constructor(options: BeadsCliWorkQueueOptions) {
    this.cwd = options.cwd;
    this.bin = options.bin ?? process.env.WEAVEKIT_BEADS_BIN ?? "bd";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.runCommand = options.runCommand ?? defaultRunner;
  }

  async ready(filter: ReadyWorkFilter = {}): Promise<WorkItem[]> {
    const parsed = ReadyWorkFilterSchema.parse(filter);
    const args = ["ready", "--json"];
    if (parsed.priority !== undefined) args.push("--priority", String(parsed.priority));
    if (parsed.assignee) args.push("--assignee", parsed.assignee);
    if (parsed.limit !== undefined) args.push("--limit", String(parsed.limit));

    const result = await this.run(args);
    return parseWorkItemList("ready", result.stdout);
  }

  async show(id: string): Promise<WorkItem> {
    const result = await this.run(["show", id, "--json"]);
    return parseWorkItem("show", result.stdout);
  }

  async claim(id: string): Promise<WorkItem> {
    const result = await this.run(["update", id, "--claim", "--json"]);
    return parseWorkItem("update", result.stdout);
  }

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const parsed = CreateWorkItemInputSchema.parse(input);
    const args = ["create", parsed.title, "-t", parsed.type, "-p", String(parsed.priority)];

    if (parsed.description) args.push("--description", parsed.description);
    for (const label of parsed.labels) args.push("--label", label);
    for (const dep of parsed.dependencies) args.push("--deps", `${dep.type}:${dep.id}`);
    args.push("--json");

    const result = await this.run(args);
    return parseWorkItem("create", result.stdout);
  }

  async close(id: string, input: CompleteWorkItemInput): Promise<WorkItem> {
    const parsed = CompleteWorkItemInputSchema.parse(input);
    const result = await this.run(["close", id, "--reason", parsed.reason, "--json"]);
    return parseWorkItem("close", result.stdout);
  }

  async sync(): Promise<void> {
    await this.run(["dolt", "push"]);
  }

  private async run(args: string[]): Promise<BeadsCommandResult> {
    return await this.runCommand(this.bin, args, { cwd: this.cwd, timeoutMs: this.timeoutMs });
  }
}
