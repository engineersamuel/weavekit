# Beads-Generated Council Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--create-beads-workflow` so a Decision Council run can create a Beads DAG, run under the generated `run-council` item, and serialize the whole workflow DAG into Langfuse trace metadata.

**Architecture:** Keep `runDecisionCouncil(...)` as the core execution module. Add a Beads orchestration module at the work-queue seam that creates the four-item workflow and returns a small `DecisionCouncilBeadsWorkflow` object; the CLI coordinates this module with the existing council runner. Extend work-queue telemetry to serialize a workflow DAG while preserving existing single-item attachment behavior.

**Tech Stack:** TypeScript, Nub, Vitest, OpenTelemetry API, Langfuse OTEL attributes, existing `WorkQueueBackend` and `BeadsCliWorkQueue`.

## Global Constraints

- No automatic Beads creation unless `--create-beads-workflow` is supplied.
- No replacement of `runDecisionCouncil(...)`.
- No Rivet integration.
- No full Beads molecule/formula support unless the existing `WorkQueueBackend` can support it cleanly.
- No Beads item per internal council/persona/BAML operation.
- Use Nub for Node.js package and script management (`nub run`, `nub install`, `nubx`).
- `--work-item <id>` and `--create-beads-workflow` are mutually exclusive. Supplying both is a CLI error.
- Runs without `--work-item` or `--create-beads-workflow` do not create or touch Beads.

---

## File Structure

- Create `src/work-queue/decisionCouncilWorkflow.ts`: owns the generated Beads workflow shape and returns `DecisionCouncilBeadsWorkflow`.
- Modify `src/work-queue/index.ts`: exports the new workflow module.
- Modify `src/work-queue/telemetry.ts`: adds workflow DAG serialization and root trace metadata helper.
- Modify `src/work-queue/decisionCouncil.ts`: accepts optional workflow DAG metadata and closes only the active generated `run-council` item.
- Modify `src/decision-council/runner.ts`: accepts optional workflow DAG telemetry context and attaches it to the root span.
- Modify `src/cli.ts`: parses `--create-beads-workflow`, rejects it with `--work-item`, creates workflow before running council, and passes generated work queue options.
- Modify `tests/work-queue/decisionCouncilWorkflow.test.ts`: verifies generated Beads DAG creation.
- Modify `tests/work-queue/telemetry.test.ts`: verifies workflow DAG metadata serialization.
- Modify `tests/cli.test.ts`: verifies CLI parsing and mutual exclusion.
- Modify `tests/decision-council/runner.test.ts`: verifies root trace workflow DAG metadata.
- Modify `README.md` and `docs/beads.md`: documents create mode and how it differs from attach mode.

### Task 1: CLI Parse Surface for `--create-beads-workflow`

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: existing `parseDecisionCouncilCliArgs(argv: string[]): DecisionCouncilCliArgs`.
- Produces: `DecisionCouncilCliArgs.createBeadsWorkflow: boolean`.

- [ ] **Step 1: Write failing CLI parse tests**

Add these tests in `tests/cli.test.ts` inside `describe("CLI", ...)`:

```ts
  it("parses --create-beads-workflow", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "x.md",
      "--create-beads-workflow",
    ]);

    expect(parsed.createBeadsWorkflow).toBe(true);
    expect(parsed.workItemId).toBeUndefined();
  });

  it("rejects --create-beads-workflow with --work-item", () => {
    expect(() =>
      parseDecisionCouncilCliArgs([
        "decision-council",
        "run",
        "--input",
        "x.md",
        "--work-item",
        "bd-root",
        "--create-beads-workflow",
      ]),
    ).toThrow("--work-item <id> and --create-beads-workflow are mutually exclusive.");
  });
```

Update the expected objects in the existing `"parses decision-council run arguments"` and `"parses JSON log format"` tests to include:

```ts
      createBeadsWorkflow: false,
```

- [ ] **Step 2: Run tests to verify failure**

Run: `nub run test -- tests/cli.test.ts -t "create-beads-workflow|parses decision-council run arguments|parses JSON log format"`

Expected: FAIL because `createBeadsWorkflow` does not exist and mutual exclusion is not implemented.

- [ ] **Step 3: Implement parsing**

In `src/cli.ts`, extend `DecisionCouncilCliArgs`:

```ts
  createBeadsWorkflow: boolean;
```

In `parseDecisionCouncilCliArgs`, after work item parsing:

```ts
  const createBeadsWorkflow = argv.includes("--create-beads-workflow");
  if (createBeadsWorkflow && workItemId) {
    throw new Error("--work-item <id> and --create-beads-workflow are mutually exclusive.");
  }
```

Include `createBeadsWorkflow` in the return object.

- [ ] **Step 4: Run tests**

Run: `nub run test -- tests/cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): parse create beads workflow mode"
```

### Task 2: Beads Workflow Creation Module

**Files:**
- Create: `src/work-queue/decisionCouncilWorkflow.ts`
- Modify: `src/work-queue/index.ts`
- Test: `tests/work-queue/decisionCouncilWorkflow.test.ts`

**Interfaces:**
- Consumes: `WorkQueueBackend.create(input: CreateWorkItemInput): Promise<WorkItem>`.
- Produces:

```ts
export type DecisionCouncilBeadsWorkflow = {
  rootItem: WorkItem;
  runItem: WorkItem;
  reviewItem: WorkItem;
  followUpItem: WorkItem;
  items: WorkItem[];
};

export async function createDecisionCouncilBeadsWorkflow(args: {
  backend: WorkQueueBackend;
  title: string;
  inputPath?: string;
  outputDir?: string;
}): Promise<DecisionCouncilBeadsWorkflow>;
```

- [ ] **Step 1: Write failing workflow creation test**

Create `tests/work-queue/decisionCouncilWorkflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDecisionCouncilBeadsWorkflow } from "../../src/work-queue/decisionCouncilWorkflow.js";
import type { WorkQueueBackend } from "../../src/work-queue/backend.js";
import type { CreateWorkItemInput, ReadyWorkFilter, WorkItem } from "../../src/work-queue/schema.js";

function itemFrom(input: CreateWorkItemInput, id: string): WorkItem {
  return {
    id,
    title: input.title,
    description: input.description,
    status: "open",
    type: input.type,
    priority: input.priority,
    labels: input.labels,
    dependencies: input.dependencies,
  };
}

describe("createDecisionCouncilBeadsWorkflow", () => {
  it("creates a four-item Decision Council workflow DAG", async () => {
    const created: CreateWorkItemInput[] = [];
    const backend: WorkQueueBackend = {
      async ready(_filter?: ReadyWorkFilter) { return []; },
      async show() { throw new Error("not used"); },
      async claim(id: string) { throw new Error(`not used ${id}`); },
      async create(input: CreateWorkItemInput) {
        created.push(input);
        return itemFrom(input, `bd-${created.length}`);
      },
      async close() { throw new Error("not used"); },
      async sync() {},
    };

    const workflow = await createDecisionCouncilBeadsWorkflow({
      backend,
      title: "Evaluate architecture",
      inputPath: "examples/design-question.md",
      outputDir: "runs/generated",
    });

    expect(workflow.items.map((item) => item.id)).toEqual(["bd-1", "bd-2", "bd-3", "bd-4"]);
    expect(workflow.rootItem.id).toBe("bd-1");
    expect(workflow.runItem.id).toBe("bd-2");
    expect(workflow.reviewItem.id).toBe("bd-3");
    expect(workflow.followUpItem.id).toBe("bd-4");
    expect(created.map((input) => input.title)).toEqual([
      "Frame decision question: Evaluate architecture",
      "Run Decision Council: Evaluate architecture",
      "Review Decision Council report: Evaluate architecture",
      "Implement next experiment: Evaluate architecture",
    ]);
    expect(created[1]?.dependencies).toEqual([{ type: "waits-for", id: "bd-1" }]);
    expect(created[2]?.dependencies).toEqual([{ type: "waits-for", id: "bd-2" }]);
    expect(created[3]?.dependencies).toEqual([{ type: "waits-for", id: "bd-3" }]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `nub run test -- tests/work-queue/decisionCouncilWorkflow.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement workflow creation**

Create `src/work-queue/decisionCouncilWorkflow.ts`:

```ts
import type { WorkQueueBackend } from "./backend.js";
import type { WorkItem } from "./schema.js";

export type DecisionCouncilBeadsWorkflow = {
  rootItem: WorkItem;
  runItem: WorkItem;
  reviewItem: WorkItem;
  followUpItem: WorkItem;
  items: WorkItem[];
};

export async function createDecisionCouncilBeadsWorkflow(args: {
  backend: WorkQueueBackend;
  title: string;
  inputPath?: string;
  outputDir?: string;
}): Promise<DecisionCouncilBeadsWorkflow> {
  const { backend, title, inputPath, outputDir } = args;
  const labels = ["weavekit", "decision-council"];
  const contextLines = [
    inputPath ? `Input: ${inputPath}` : undefined,
    outputDir ? `Output: ${outputDir}` : undefined,
  ].filter((line): line is string => line !== undefined);

  const rootItem = await backend.create({
    title: `Frame decision question: ${title}`,
    description: ["Frame the question and constraints for this Decision Council run.", ...contextLines].join("\n"),
    type: "decision",
    priority: 2,
    labels,
    dependencies: [],
  });

  const runItem = await backend.create({
    title: `Run Decision Council: ${title}`,
    description: ["Run Weavekit Decision Council for the framed question.", ...contextLines].join("\n"),
    type: "task",
    priority: 2,
    labels,
    dependencies: [{ type: "waits-for", id: rootItem.id }],
  });

  const reviewItem = await backend.create({
    title: `Review Decision Council report: ${title}`,
    description: ["Review the generated Decision Council report before follow-up work begins.", ...contextLines].join("\n"),
    type: "task",
    priority: 2,
    labels,
    dependencies: [{ type: "waits-for", id: runItem.id }],
  });

  const followUpItem = await backend.create({
    title: `Implement next experiment: ${title}`,
    description: ["Implement or refine the next experiment after reviewing the Decision Council report.", ...contextLines].join("\n"),
    type: "task",
    priority: 2,
    labels,
    dependencies: [{ type: "waits-for", id: reviewItem.id }],
  });

  return {
    rootItem,
    runItem,
    reviewItem,
    followUpItem,
    items: [rootItem, runItem, reviewItem, followUpItem],
  };
}
```

Modify `src/work-queue/index.ts`:

```ts
export * from "./decisionCouncilWorkflow.js";
```

- [ ] **Step 4: Run tests**

Run: `nub run test -- tests/work-queue/decisionCouncilWorkflow.test.ts tests/work-queue/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/work-queue/decisionCouncilWorkflow.ts src/work-queue/index.ts tests/work-queue/decisionCouncilWorkflow.test.ts
git commit -m "feat(work-queue): create decision council beads workflow"
```

### Task 3: Workflow DAG Telemetry Metadata

**Files:**
- Modify: `src/work-queue/telemetry.ts`
- Test: `tests/work-queue/telemetry.test.ts`

**Interfaces:**
- Consumes: `WorkItem[]`, root item id, and active item id.
- Produces:

```ts
export type WorkItemWorkflowDag = {
  rootItemId: string;
  activeItemId: string;
  items: ReturnType<typeof serializeWorkItemDag>[];
};

export function serializeWorkItemWorkflowDag(args: {
  rootItemId: string;
  activeItemId: string;
  items: WorkItem[];
}): WorkItemWorkflowDag;

export function setWorkItemWorkflowTraceAttributes(
  span: Pick<Span, "setAttribute">,
  dag: WorkItemWorkflowDag,
): void;
```

- [ ] **Step 1: Write failing telemetry tests**

Add to `tests/work-queue/telemetry.test.ts` imports:

```ts
import { serializeWorkItemWorkflowDag, setWorkItemWorkflowTraceAttributes } from "../../src/work-queue/telemetry.js";
```

Add tests:

```ts
  it("serializes a workflow DAG for Langfuse metadata", () => {
    const second: WorkItem = {
      ...item,
      id: "bd-run",
      title: "Run Decision Council",
      dependencies: [{ type: "waits-for", id: "bd-root" }],
    };

    expect(serializeWorkItemWorkflowDag({
      rootItemId: "bd-root",
      activeItemId: "bd-run",
      items: [item, second],
    })).toEqual({
      rootItemId: "bd-root",
      activeItemId: "bd-run",
      items: [
        {
          id: "bd-root",
          title: "Run Decision Council",
          status: "open",
          type: "task",
          priority: 1,
          labels: ["weavekit"],
          dependencies: [{ type: "waits-for", id: "bd-parent" }],
        },
        {
          id: "bd-run",
          title: "Run Decision Council",
          status: "open",
          type: "task",
          priority: 1,
          labels: ["weavekit"],
          dependencies: [{ type: "waits-for", id: "bd-root" }],
        },
      ],
    });
  });

  it("sets workflow DAG trace metadata", () => {
    const attributes: Record<string, unknown> = {};
    const span = { setAttribute: vi.fn((key: string, value: unknown) => { attributes[key] = value; }) };
    const dag = serializeWorkItemWorkflowDag({
      rootItemId: "bd-root",
      activeItemId: "bd-root",
      items: [item],
    });

    setWorkItemWorkflowTraceAttributes(span as never, dag);

    expect(JSON.parse(attributes["langfuse.trace.metadata.beads.workflow_dag"] as string)).toMatchObject({
      rootItemId: "bd-root",
      activeItemId: "bd-root",
      items: [{ id: "bd-root" }],
    });
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `nub run test -- tests/work-queue/telemetry.test.ts`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement telemetry helpers**

In `src/work-queue/telemetry.ts`, add:

```ts
export type WorkItemWorkflowDag = {
  rootItemId: string;
  activeItemId: string;
  items: ReturnType<typeof serializeWorkItemDag>[];
};

export function serializeWorkItemWorkflowDag(args: {
  rootItemId: string;
  activeItemId: string;
  items: WorkItem[];
}): WorkItemWorkflowDag {
  return {
    rootItemId: args.rootItemId,
    activeItemId: args.activeItemId,
    items: args.items.map(serializeWorkItemDag),
  };
}

export function setWorkItemWorkflowTraceAttributes(
  span: Pick<Span, "setAttribute">,
  dag: WorkItemWorkflowDag,
): void {
  span.setAttribute("weavekit.work_queue.workflow_root_item_id", dag.rootItemId);
  span.setAttribute("weavekit.work_queue.workflow_active_item_id", dag.activeItemId);
  span.setAttribute("weavekit.work_queue.workflow_item_count", dag.items.length);
  setSerializedAttribute(span as Span, "langfuse.trace.metadata.beads.workflow_dag", dag);
}
```

- [ ] **Step 4: Run tests**

Run: `nub run test -- tests/work-queue/telemetry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/work-queue/telemetry.ts tests/work-queue/telemetry.test.ts
git commit -m "feat(work-queue): serialize beads workflow dag telemetry"
```

### Task 4: Runner Support for Workflow DAG Metadata

**Files:**
- Modify: `src/decision-council/runner.ts`
- Test: `tests/decision-council/runner.test.ts`

**Interfaces:**
- Consumes: `RunDecisionCouncilOptions.workQueueWorkflowDag?: WorkItemWorkflowDag`.
- Produces: root span `langfuse.trace.metadata.beads.workflow_dag`.

- [ ] **Step 1: Write failing runner telemetry test**

In `tests/decision-council/runner.test.ts`, add after the existing Beads metadata test:

```ts
  it("attaches generated Beads workflow DAG metadata to the root Langfuse trace", async () => {
    const backend = {
      async ready() { return []; },
      async show(id: string) {
        return {
          id,
          title: "Run Council",
          status: "open" as const,
          type: "task" as const,
          priority: 1,
          labels: ["weavekit"],
          dependencies: [],
        };
      },
      async claim(id: string) {
        return { id, title: "Run Council", status: "in_progress" as const, type: "task" as const, priority: 1, labels: [], dependencies: [] };
      },
      async create() { throw new Error("not used"); },
      async close(id: string, input: { reason: string }) {
        return { id, title: input.reason, status: "closed" as const, type: "task" as const, priority: 1, labels: [], dependencies: [] };
      },
      async sync() {},
    };

    await runCouncilForTest(
      { prompt: "Trace workflow DAG." },
      {
        workQueue: { backend, workItemId: "bd-run", claimOnStart: true },
        workQueueWorkflowDag: {
          rootItemId: "bd-frame",
          activeItemId: "bd-run",
          items: [
            { id: "bd-frame", title: "Frame", status: "open", type: "decision", priority: 2, labels: [], dependencies: [] },
            { id: "bd-run", title: "Run", status: "open", type: "task", priority: 2, labels: [], dependencies: [{ type: "waits-for", id: "bd-frame" }] },
          ],
        },
        deps: { personaWorker: fakeWorker(), normalizer, judge: judge(1), writeArtifacts: false },
      },
    );

    const rootSpan = telemetry.spans.find((span) => span.name === "council-run");
    expect(JSON.parse(rootSpan?.attributes["langfuse.trace.metadata.beads.workflow_dag"] as string)).toMatchObject({
      rootItemId: "bd-frame",
      activeItemId: "bd-run",
      items: [{ id: "bd-frame" }, { id: "bd-run" }],
    });
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `nub run test -- tests/decision-council/runner.test.ts -t "workflow DAG metadata"`

Expected: FAIL because `workQueueWorkflowDag` is not accepted or attached.

- [ ] **Step 3: Implement runner support**

In `src/decision-council/runner.ts`, import:

```ts
import { setWorkItemTraceAttributes, setWorkItemWorkflowTraceAttributes, type WorkItemWorkflowDag } from "../work-queue/telemetry.js";
```

Extend `RunDecisionCouncilOptions`:

```ts
  workQueueWorkflowDag?: WorkItemWorkflowDag;
```

After existing `setWorkItemTraceAttributes(span, sourceWorkItem);`, add:

```ts
      if (options.workQueueWorkflowDag) {
        setWorkItemWorkflowTraceAttributes(span, options.workQueueWorkflowDag);
      }
```

- [ ] **Step 4: Run tests**

Run: `nub run test -- tests/decision-council/runner.test.ts tests/work-queue/telemetry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision-council/runner.ts tests/decision-council/runner.test.ts
git commit -m "feat(decision-council): attach beads workflow dag metadata"
```

### Task 5: CLI Orchestration for Generated Workflow Mode

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/cli-main.test.ts`

**Interfaces:**
- Consumes:
  - `createDecisionCouncilBeadsWorkflow(args): Promise<DecisionCouncilBeadsWorkflow>`
  - `serializeWorkItemWorkflowDag(args): WorkItemWorkflowDag`
- Produces: `--create-beads-workflow` execution path that creates the workflow and runs under `workflow.runItem.id`.

- [ ] **Step 1: Write failing CLI orchestration unit test**

If direct `main()` dependency injection is not available, add a focused exported helper in Step 3 and test it. First add this test to `tests/cli.test.ts`:

```ts
  it("accepts --create-beads-workflow without lifecycle flags", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "x.md",
      "--create-beads-workflow",
    ]);

    expect(parsed).toMatchObject({
      createBeadsWorkflow: true,
      workItemId: undefined,
      claimWorkItem: false,
      closeWorkItem: false,
      createFollowUpWorkItem: false,
      syncWorkQueue: false,
    });
  });
```

Add a `tests/cli-main.test.ts` integration assertion by mocking only if current test patterns support it. If not, keep CLI execution wiring covered through exported helper tests in `tests/cli.test.ts`.

- [ ] **Step 2: Run test to verify failure**

Run: `nub run test -- tests/cli.test.ts`

Expected: FAIL until helper/wiring exists.

- [ ] **Step 3: Implement CLI orchestration**

In `src/cli.ts`, import:

```ts
import { createDecisionCouncilBeadsWorkflow } from "./work-queue/decisionCouncilWorkflow.js";
import { serializeWorkItemWorkflowDag } from "./work-queue/telemetry.js";
```

In `main()`, replace the current `workQueue` construction with:

```ts
    const backend = args.workItemId || args.createBeadsWorkflow
      ? new BeadsCliWorkQueue({ cwd: process.cwd() })
      : undefined;
    const generatedWorkflow = args.createBeadsWorkflow && backend
      ? await createDecisionCouncilBeadsWorkflow({
          backend,
          title: input.prompt.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 80) ?? "Decision Council run",
          inputPath: args.inputPath,
          outputDir: args.outputDir,
        })
      : undefined;
    const activeWorkItemId = args.workItemId ?? generatedWorkflow?.runItem.id;
    const workQueue = backend && activeWorkItemId
      ? {
          backend,
          workItemId: activeWorkItemId,
          claimOnStart: args.claimWorkItem || args.createBeadsWorkflow,
          closeOnSuccess: args.closeWorkItem || args.createBeadsWorkflow,
          createFollowUp: args.workItemId ? args.createFollowUpWorkItem : false,
          syncOnComplete: args.syncWorkQueue,
        }
      : undefined;
    const workQueueWorkflowDag = generatedWorkflow
      ? serializeWorkItemWorkflowDag({
          rootItemId: generatedWorkflow.rootItem.id,
          activeItemId: generatedWorkflow.runItem.id,
          items: generatedWorkflow.items,
        })
      : undefined;
```

Pass `workQueueWorkflowDag` into `runDecisionCouncil(...)`.

- [ ] **Step 4: Run tests**

Run: `nub run test -- tests/cli.test.ts tests/cli-main.test.ts tests/decision-council/runner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts tests/cli-main.test.ts
git commit -m "feat(cli): run council from generated beads workflow"
```

### Task 6: Workflow Creation Spans

**Files:**
- Modify: `src/work-queue/decisionCouncilWorkflow.ts`
- Modify: `src/work-queue/telemetry.ts`
- Test: `tests/work-queue/decisionCouncilWorkflow.test.ts`

**Interfaces:**
- Consumes: `runWorkQueueSpan("create-workflow" | "create-workflow-item", ...)`.
- Produces child observations:
  - `work-queue.beads.create-workflow`
  - `work-queue.beads.create-workflow-item`

- [ ] **Step 1: Write failing span test**

In `tests/work-queue/decisionCouncilWorkflow.test.ts`, import:

```ts
import * as telemetry from "../../src/work-queue/telemetry.js";
import { vi } from "vitest";
```

Add:

```ts
  it("wraps workflow and item creation in Beads telemetry spans", async () => {
    const operations: string[] = [];
    const spy = vi.spyOn(telemetry, "runWorkQueueSpan");
    spy.mockImplementation(async (operation, _context, fn) => {
      operations.push(operation);
      return fn();
    });
    const created: CreateWorkItemInput[] = [];
    const backend: WorkQueueBackend = {
      async ready(_filter?: ReadyWorkFilter) { return []; },
      async show() { throw new Error("not used"); },
      async claim(id: string) { throw new Error(`not used ${id}`); },
      async create(input: CreateWorkItemInput) {
        created.push(input);
        return itemFrom(input, `bd-${created.length}`);
      },
      async close() { throw new Error("not used"); },
      async sync() {},
    };

    await createDecisionCouncilBeadsWorkflow({ backend, title: "Trace workflow" });

    expect(operations).toEqual([
      "create-workflow",
      "create-workflow-item",
      "create-workflow-item",
      "create-workflow-item",
      "create-workflow-item",
    ]);
    spy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `nub run test -- tests/work-queue/decisionCouncilWorkflow.test.ts`

Expected: FAIL because the new operations are not in the union or not used.

- [ ] **Step 3: Implement span wrapping**

In `src/work-queue/telemetry.ts`, extend `WorkQueueOperation`:

```ts
  | "create-workflow"
  | "create-workflow-item"
```

In `src/work-queue/decisionCouncilWorkflow.ts`, import `runWorkQueueSpan` and wrap the whole function:

```ts
  return runWorkQueueSpan("create-workflow", { itemId: "generated" }, async () => {
    // existing creation body
  });
```

Wrap each `backend.create(...)` call:

```ts
  const rootItem = await runWorkQueueSpan("create-workflow-item", { itemId: "frame-question" }, async () =>
    backend.create({ ... }),
  );
```

Use item ids in the span context as stable logical step names before Beads assigns real ids:

- `frame-question`
- `run-council`
- `review-report`
- `implement-next-experiment`

- [ ] **Step 4: Run tests**

Run: `nub run test -- tests/work-queue/decisionCouncilWorkflow.test.ts tests/work-queue/telemetry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/work-queue/decisionCouncilWorkflow.ts src/work-queue/telemetry.ts tests/work-queue/decisionCouncilWorkflow.test.ts
git commit -m "feat(work-queue): trace beads workflow creation"
```

### Task 7: Documentation and Final Validation

**Files:**
- Modify: `README.md`
- Modify: `docs/beads.md`
- Test: `tests/work-queue/beads-docs-sync.test.ts`

**Interfaces:**
- Consumes: implemented CLI flag and span/metadata names.
- Produces: docs for create mode and attach mode.

- [ ] **Step 1: Update documentation**

Add to `docs/beads.md` near Workflow fit:

```md
### Generated workflow mode

Use `--create-beads-workflow` when you want Weavekit to create the Beads DAG for a new Decision Council run:

```bash
nub run council decision-council run \
  --input examples/design-question.md \
  --create-beads-workflow
```

This creates four Beads items:

1. `frame-question`
2. `run-council`
3. `review-report`
4. `implement-next-experiment`

The council runs under the generated `run-council` item. Langfuse receives `langfuse.trace.metadata.beads.workflow_dag` with all generated items. Use `--work-item <id>` instead when you already have a Beads item and only want to attach a run to it.
```

Add to `README.md` near the Beads section:

```md
To create a Beads workflow for a new council run, use `--create-beads-workflow`. To attach to an existing Beads item, use `--work-item <id>`.
```

- [ ] **Step 2: Update docs sync test if needed**

If `tests/work-queue/beads-docs-sync.test.ts` asserts exact strings, add checks for:

```ts
expect(text).toContain("--create-beads-workflow");
expect(text).toContain("langfuse.trace.metadata.beads.workflow_dag");
```

- [ ] **Step 3: Run final targeted tests**

Run:

```bash
nub run test -- tests/cli.test.ts tests/cli-main.test.ts tests/decision-council/runner.test.ts tests/work-queue/decisionCouncilWorkflow.test.ts tests/work-queue/decisionCouncil.test.ts tests/work-queue/telemetry.test.ts tests/work-queue/beads-docs-sync.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run: `nub run test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/beads.md tests/work-queue/beads-docs-sync.test.ts
git commit -m "docs: explain generated beads council workflows"
```

## Self-Review

- Spec coverage: tasks cover CLI parsing, workflow creation, telemetry DAG metadata, runner metadata attachment, CLI orchestration, creation spans, docs, and validation.
- Placeholder scan: no open placeholder markers are intended; every code-changing step includes concrete code.
- Type consistency: `DecisionCouncilBeadsWorkflow`, `WorkItemWorkflowDag`, `createDecisionCouncilBeadsWorkflow`, `serializeWorkItemWorkflowDag`, and `setWorkItemWorkflowTraceAttributes` are defined before later tasks consume them.
