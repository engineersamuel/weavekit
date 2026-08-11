import { join } from "node:path";
import { z } from "zod";
import { SubmindManifestSchema, WorkerKind, type SubmindRunState } from "./contracts.js";
import { createScopedHerdrForRun } from "./runtime.js";
import { SubmindStore } from "./store.js";

const SplitInputSchema = z
  .object({ paneId: z.string().min(1), direction: z.enum(["right", "down"]) })
  .strict();
const TabInputSchema = z.object({ label: z.string().trim().min(1).max(128) }).strict();
const LaunchInputSchema = z
  .object({
    paneId: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().optional(),
    command: z.string().min(1),
    args: z.array(z.string()),
    interactive: z.boolean().optional(),
  })
  .strict();
const RenameInputSchema = z
  .object({ agentId: z.string().min(1), name: z.string().min(1) })
  .strict();
const PromptInputSchema = z
  .object({ agentId: z.string().min(1), prompt: z.string().min(1) })
  .strict();
const PlanInputSchema = z.object({ agentId: z.string().min(1) }).strict();
const SubmitInputSchema = z.object({ agentId: z.string().min(1) }).strict();
const WaitInputSchema = z
  .object({
    agentId: z.string().min(1),
    states: z.array(z.enum(["idle", "working", "blocked", "done", "failed"])).min(1),
    timeoutMs: z.number().int().positive().max(120_000),
  })
  .strict();
const ReadInputSchema = z
  .object({ agentId: z.string().min(1), lines: z.number().int().positive().max(500).optional() })
  .strict();
const EventInputSchema = z
  .object({ type: z.enum(["operation", "receipt", "failure"]), data: z.record(z.unknown()) })
  .strict();

export async function runHelper(input: {
  controlRoot: string;
  runId: string;
  operation: string;
  payload: unknown;
}): Promise<unknown> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/u.test(input.runId)) {
    throw new Error("Invalid submind run ID.");
  }
  const store = new SubmindStore(join(input.controlRoot, ".weavekit", "submind-poc", input.runId));
  const state = await store.readState();
  if (state.runId !== input.runId) throw new Error("Persisted run identity mismatch.");
  if (input.operation === "event") {
    const event = EventInputSchema.parse(input.payload);
    if (event.data.source === "helper") {
      throw new Error("Caller events cannot use reserved helper receipt source.");
    }
    return store.appendEvent({
      runId: state.runId,
      type: event.type,
      timestamp: new Date().toISOString(),
      data: event.data,
    });
  }
  if (input.operation === "complete") {
    const manifest = SubmindManifestSchema.parse(input.payload);
    assertManifestIdentity(manifest, state);
    if (Date.parse(manifest.startedAt) < Date.parse(state.createdAt)) {
      throw new Error("Manifest start timestamp predates persisted run creation.");
    }
    if (manifest.outcome === "completed") await assertRequiredReceipts(store, manifest);
    const { client, scoped } = await createScopedHerdrForRun(state);
    try {
      const snapshot = await scoped.snapshot();
      const orchestrator = snapshot.agents.find(
        (candidate) => candidate.id === manifest.orchestrator.agentId,
      );
      if (manifest.outcome === "completed" && orchestrator?.kind !== WorkerKind.COPILOT) {
        throw new Error("Completed manifest requires a live Copilot orchestrator.");
      }
      const participants = [manifest.orchestrator, ...manifest.workers];
      for (const participant of participants) {
        const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
        const pane = snapshot.panes.find((candidate) => candidate.id === participant.paneId);
        if (
          !agent ||
          !pane ||
          pane.workspaceId !== state.workspaceId ||
          agent.paneId !== pane.id ||
          agent.name !== participant.name ||
          !agent.name.startsWith(state.agentPrefix) ||
          (manifest.outcome === "completed" &&
            (pane.exited ||
              ["blocked", "failed", "unknown", "exited"].includes(agent.status ?? "unknown")))
        ) {
          throw new Error(`Manifest participant is outside live run scope: ${participant.agentId}`);
        }
      }
      for (const worker of manifest.workers) {
        const agent = snapshot.agents.find((candidate) => candidate.id === worker.agentId);
        if (manifest.outcome === "completed" && agent?.kind !== worker.kind) {
          throw new Error(`Wrong detected worker kind for ${worker.name}: ${agent?.kind}`);
        }
        if (
          manifest.outcome === "completed" &&
          worker.command !== expectedWorkerCommand(worker.kind)
        ) {
          throw new Error(`Manifest worker command is invalid for ${worker.name}.`);
        }
        if (
          manifest.outcome === "completed" &&
          !worker.question.toLowerCase().includes(expectedQuestionSubject(worker.kind))
        ) {
          throw new Error(`Manifest worker question is invalid for ${worker.name}.`);
        }
      }
    } finally {
      client.close();
    }
    const receipt = await store.appendEvent({
      runId: state.runId,
      type: "receipt",
      timestamp: new Date().toISOString(),
      data: {
        source: "helper",
        operation: "manifest.complete",
        outcome: manifest.outcome,
        verified: true,
      },
    });
    await store.writeManifest(manifest);
    return receipt;
  }

  const { client, scoped } = await createScopedHerdrForRun(state);
  try {
    switch (input.operation) {
      case "snapshot":
        return await withOperationReceipt(store, state.runId, "snapshot", {}, () =>
          scoped.snapshot(),
        );
      case "split": {
        const payload = SplitInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "split",
          { paneId: payload.paneId, direction: payload.direction },
          () => scoped.split(payload.paneId, payload.direction),
          true,
          (result) => ({ createdPaneId: result.id }),
        );
      }
      case "tab": {
        const payload = TabInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "tab",
          { label: payload.label },
          () => scoped.createTab(payload.label),
          true,
          (result) => ({ createdPaneId: result.id, createdTabId: result.tabId }),
        );
      }
      case "launch": {
        const payload = LaunchInputSchema.parse(input.payload);
        validateWorkerLaunch(payload, state.agentPrefix);
        return await withOperationReceipt(
          store,
          state.runId,
          "launch",
          { paneId: payload.paneId, name: payload.name, command: payload.command },
          () => scoped.launch(payload),
          true,
          (result) => (result.id ? { launchedAgentId: result.id } : {}),
        );
      }
      case "rename": {
        const payload = RenameInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "rename",
          { agentId: payload.agentId, name: payload.name },
          () => scoped.rename(payload.agentId, payload.name),
          true,
        );
      }
      case "prompt": {
        const payload = PromptInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "prompt",
          { agentId: payload.agentId, promptLength: payload.prompt.length },
          () => scoped.prompt(payload.agentId, payload.prompt),
          true,
        );
      }
      case "plan": {
        const payload = PlanInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "plan",
          { agentId: payload.agentId },
          () => scoped.enableCodexPlanMode(payload.agentId),
          true,
        );
      }
      case "submit": {
        const payload = SubmitInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "submit",
          { agentId: payload.agentId },
          () => scoped.submitPendingInput(payload.agentId),
          true,
        );
      }
      case "wait": {
        const payload = WaitInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "wait",
          { agentId: payload.agentId, states: payload.states, timeoutMs: payload.timeoutMs },
          () => scoped.wait(payload.agentId, payload.states, payload.timeoutMs),
        );
      }
      case "read": {
        const payload = ReadInputSchema.parse(input.payload);
        return await withOperationReceipt(
          store,
          state.runId,
          "read",
          { agentId: payload.agentId, lines: payload.lines ?? 80 },
          () => scoped.read(payload.agentId, payload.lines),
        );
      }
      default:
        throw new Error(`Unsupported scoped helper operation: ${input.operation}`);
    }
  } finally {
    client.close();
  }
}

async function withOperationReceipt<T>(
  store: SubmindStore,
  runId: string,
  operation: string,
  data: Record<string, unknown>,
  execute: () => Promise<T>,
  mutating = false,
  resultData: (result: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  if (mutating) {
    await store.appendEvent({
      runId,
      type: "intent",
      timestamp: new Date().toISOString(),
      data: { source: "helper", operation: `${operation}.requested`, ...data },
    });
  }
  try {
    const result = await execute();
    await store.appendEvent({
      runId,
      type: "receipt",
      timestamp: new Date().toISOString(),
      data: {
        source: "helper",
        operation: `${operation}.accepted`,
        ...data,
        ...resultData(result),
      },
    });
    return result;
  } catch (error) {
    await store.appendEvent({
      runId,
      type: "failure",
      timestamp: new Date().toISOString(),
      data: {
        source: "helper",
        operation: `${operation}.failed`,
        ambiguous: mutating,
        message: error instanceof Error ? error.message : String(error),
        ...data,
      },
    });
    throw error;
  }
}

export async function assertRequiredReceipts(
  store: SubmindStore,
  manifest: z.infer<typeof SubmindManifestSchema>,
): Promise<void> {
  const receipts = (await store.readEvents()).filter(
    (event) => event.type === "receipt" && event.data.source === "helper",
  );
  const tabPaneIds = new Set(
    receipts
      .filter((event) => event.data.operation === "tab.accepted")
      .map((event) => event.data.createdPaneId)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const worker of manifest.workers) {
    if (!tabPaneIds.has(worker.paneId)) {
      throw new Error(`Missing tab receipt for worker pane: ${worker.paneId}`);
    }
    const launch = receipts.find(
      (event) =>
        event.data.operation === "launch.accepted" &&
        event.data.name === worker.name &&
        event.data.paneId === worker.paneId,
    );
    if (!launch) throw new Error(`Missing launch receipt for worker: ${worker.name}`);
    let phaseSequence = launch.sequence;
    const rename = receipts.find(
      (event) =>
        event.sequence > launch.sequence &&
        event.data.operation === "rename.accepted" &&
        event.data.agentId === worker.agentId &&
        event.data.name === worker.name,
    );
    if (!rename) throw new Error(`Missing rename receipt for worker: ${worker.name}`);
    phaseSequence = rename.sequence;
    if (worker.kind === WorkerKind.CODEX) {
      const plan = receipts.find(
        (event) =>
          event.sequence > phaseSequence &&
          event.data.operation === "plan.accepted" &&
          event.data.agentId === worker.agentId,
      );
      if (!plan) throw new Error(`Missing Plan mode receipt for worker: ${worker.name}`);
      phaseSequence = plan.sequence;
    }
    for (const operation of [
      "prompt.accepted",
      "wait.accepted",
      "read.accepted",
      "prompt.accepted",
      "wait.accepted",
      "read.accepted",
    ]) {
      const receipt = receipts.find(
        (event) =>
          event.sequence > phaseSequence &&
          event.data.operation === operation &&
          event.data.agentId === worker.agentId,
      );
      if (!receipt) {
        throw new Error(`Missing ordered helper receipt for ${worker.name}: ${operation}.`);
      }
      phaseSequence = receipt.sequence;
    }
  }
}

export function validateWorkerLaunch(
  input: z.infer<typeof LaunchInputSchema>,
  prefix: string,
): void {
  if (!input.name.startsWith(prefix)) throw new Error("Worker name is outside run scope.");
  const expectedName =
    input.command === "copilot"
      ? `${prefix}copilot`
      : input.command === "grx"
        ? `${prefix}grok`
        : input.command === "codx"
          ? `${prefix}codex`
          : input.command === "trellage"
            ? `${prefix}claude-council`
            : undefined;
  if (input.name !== expectedName) {
    throw new Error(`Worker launch name must be canonical: ${String(expectedName)}`);
  }
  const valid =
    (input.command === "copilot" &&
      (input.kind === undefined || input.kind === WorkerKind.COPILOT) &&
      input.interactive === true &&
      same(input.args, ["--autopilot", "--allow-all", "--no-ask-user"])) ||
    (input.command === "grx" &&
      input.interactive === true &&
      same(input.args, ["superpowers", "--permission-mode", "bypassPermissions"])) ||
    (input.command === "codx" && input.interactive === true && input.args.length === 0) ||
    (input.command === "trellage" &&
      input.interactive === true &&
      same(input.args, ["--profile", "claude-council"]));
  if (!valid) throw new Error("Worker launch command is outside POC allowlist.");
}

function assertManifestIdentity(
  manifest: z.infer<typeof SubmindManifestSchema>,
  state: SubmindRunState,
): void {
  if (
    manifest.runId !== state.runId ||
    manifest.sourceRepositoryPath !== state.sourceRepositoryPath ||
    manifest.worktreePath !== state.worktreePath ||
    manifest.branchName !== state.branchName ||
    manifest.workspaceId !== state.workspaceId ||
    manifest.orchestrator.agentId !== state.orchestratorAgentId ||
    manifest.orchestrator.paneId !== state.rootPaneId ||
    manifest.orchestrator.name !== `${state.agentPrefix}orchestrator`
  ) {
    throw new Error("Manifest identity does not match persisted run state.");
  }
}

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedWorkerCommand(
  kind: z.infer<typeof SubmindManifestSchema>["workers"][number]["kind"],
): string {
  switch (kind) {
    case WorkerKind.COPILOT:
      return "copilot --autopilot --allow-all --no-ask-user";
    case WorkerKind.GROK:
      return "grx superpowers --permission-mode bypassPermissions";
    case WorkerKind.CODEX:
      return "codx";
    case WorkerKind.CLAUDE:
      return "trellage --profile claude-council";
  }
}

function expectedQuestionSubject(
  kind: z.infer<typeof SubmindManifestSchema>["workers"][number]["kind"],
): string {
  switch (kind) {
    case WorkerKind.COPILOT:
      return "color";
    case WorkerKind.GROK:
      return "movie";
    case WorkerKind.CODEX:
      return "book";
    case WorkerKind.CLAUDE:
      return "language";
  }
}
