import { describe, expect, it } from "vitest";
import { createStaticHarnessRegistry } from "../../src/macro-workflow/harness.js";
import { MacroWorkflowEventKind } from "../../src/macro-workflow/logger.js";
import type { WorkflowExecutionMetadata } from "../../src/macro-workflow/types.js";
import { materializeWorkflowPlan } from "../../src/macro-workflow/templates.js";
import { runMacroWorkflow } from "../../src/macro-workflow/runner.js";
import { WorkflowHarnessKind } from "../../src/macro-workflow/types.js";

describe("macro workflow runner", () => {
  it("executes a plan end to end using the static harness registry", async () => {
    const plan = materializeWorkflowPlan("implementation-review", { objective: "Implement rich logging" });
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "insights" }),
      [WorkflowHarnessKind.DECISION_COUNCIL]: async () => ({ status: "passed", output: "consensus" }),
      [WorkflowHarnessKind.COPILOT_SDK]: async () => ({ status: "passed", output: "implemented" }),
      [WorkflowHarnessKind.VERIFIER]: async () => ({ status: "passed", output: "verified" }),
      [WorkflowHarnessKind.REPORTER]: async () => ({ status: "passed", output: "report" }),
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("passed");
    expect(state.nodeResults).toHaveLength(plan.nodes.length);
    expect(state.nodeResults.at(-1)?.status).toBe("passed");
  });

  it("passes typed payloads from completed nodes to dependent harnesses", async () => {
    const plan = {
      id: "payload-plan",
      objective: "Pass payloads",
      templateId: "implementation-review",
      maxReplans: 0,
      nodes: [
        {
          id: "research",
          kind: "research" as const,
          harness: WorkflowHarnessKind.RESEARCH,
          title: "Research",
          prompt: "Research",
          dependsOn: [],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
        {
          id: "report",
          kind: "report" as const,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Report",
          prompt: "Report",
          dependsOn: ["research"],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const seen: unknown[] = [];
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "research", payload: { answer: 42 } }),
      [WorkflowHarnessKind.REPORTER]: async (_node, context) => {
        seen.push(context.payloads.get("research"));
        return { status: "passed", output: "report" };
      },
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("passed");
    expect(seen).toEqual([{ answer: 42 }]);
    expect(state.nodeResults[0]?.payload).toEqual({ answer: 42 });
  });

  it("passes the configured output directory to harness contexts", async () => {
    const plan = {
      id: "output-dir-plan",
      objective: "Pass output dir",
      templateId: "implementation-review",
      maxReplans: 0,
      nodes: [
        {
          id: "plan",
          kind: "planning" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Plan",
          prompt: "Plan",
          dependsOn: [],
          gates: ["verification" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const seenOutputDirs: Array<string | undefined> = [];
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: async (_node, context) => {
        seenOutputDirs.push(context.outputDir);
        return { status: "passed", output: "planned" };
      },
    });

    const state = await runMacroWorkflow(plan, { harnesses, outputDir: "runs/run-123" });

    expect(state.status).toBe("passed");
    expect(seenOutputDirs).toEqual(["runs/run-123"]);
  });

  it("records planned execution metadata when a harness throws before returning", async () => {
    const plan = {
      id: "metadata-failure-plan",
      objective: "Capture failed call metadata",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "source-reading",
          kind: "research" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Read source",
          model: "gpt-5.4",
          prompt: "Read source artifact",
          dependsOn: [],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: async () => {
        throw new Error("Timeout after 300000ms waiting for session.idle");
      },
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("failed");
    expect(state.nodeResults[0]).toMatchObject({
      nodeId: "source-reading",
      status: "failed",
      execution: {
        executor: WorkflowHarnessKind.COPILOT_SDK,
        mode: "research",
        prompt: "Read source artifact",
        model: "gpt-5.4",
        calls: [{
          executor: WorkflowHarnessKind.COPILOT_SDK,
          mode: "research",
          prompt: "Read source artifact",
          model: "gpt-5.4",
        }],
      },
    });
  });

  it("publishes resolved execution metadata before a node starts running", async () => {
    const plan = {
      id: "live-metadata-plan",
      objective: "Show live resolved prompt",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "plan-opportunity-o1",
          kind: "planning" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Plan O1",
          model: "claude-opus-4.8",
          prompt: "Create a plan artifact for accepted opportunity O1.",
          dependsOn: [],
          gates: ["verification" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const resolvedExecution: WorkflowExecutionMetadata = {
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "plan",
      prompt: "Create an implementation plan with Selected candidate JSON.",
      model: "claude-opus-4.8",
      calls: [{
        executor: WorkflowHarnessKind.COPILOT_SDK,
        mode: "plan",
        prompt: "Create an implementation plan with Selected candidate JSON.",
        model: "claude-opus-4.8",
      }],
    };
    const livePrompts: Array<string | undefined> = [];
    const adapter = Object.assign(
      async () => ({ status: "passed" as const, output: "planned", execution: resolvedExecution }),
      {
        async prepareExecution() {
          return resolvedExecution;
        },
      },
    );
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: adapter,
    });

    await runMacroWorkflow(plan, {
      harnesses,
      onStateChange(state, event) {
        if (event.type === MacroWorkflowEventKind.NODE_STARTED) {
          livePrompts.push(state.activeNodeExecutions?.["plan-opportunity-o1"]?.prompt);
        }
      },
    });

    expect(livePrompts).toEqual(["Create an implementation plan with Selected candidate JSON."]);
  });

  it("uses resolved execution metadata when a prepared harness throws before returning", async () => {
    const plan = {
      id: "prepared-metadata-failure-plan",
      objective: "Capture prepared failed call metadata",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "plan-opportunity-o1",
          kind: "planning" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Plan O1",
          model: "claude-opus-4.8",
          prompt: "Create a plan artifact for accepted opportunity O1.",
          dependsOn: [],
          gates: ["verification" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const resolvedExecution: WorkflowExecutionMetadata = {
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "plan",
      prompt: "Create an implementation plan with Selected candidate JSON.",
      model: "claude-opus-4.8",
      calls: [{
        executor: WorkflowHarnessKind.COPILOT_SDK,
        mode: "plan",
        prompt: "Create an implementation plan with Selected candidate JSON.",
        model: "claude-opus-4.8",
      }],
    };
    const adapter = Object.assign(
      async () => {
        throw new Error("Timeout after 300000ms waiting for session.idle");
      },
      {
        async prepareExecution() {
          return resolvedExecution;
        },
      },
    );
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: adapter,
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("failed");
    expect(state.nodeResults[0]?.execution?.prompt).toBe("Create an implementation plan with Selected candidate JSON.");
    expect(state.nodeResults[0]?.execution?.calls?.[0]?.prompt).toBe("Create an implementation plan with Selected candidate JSON.");
  });

  it("continues through normal adapter execution if execution metadata preparation fails", async () => {
    const plan = {
      id: "prepare-failure-plan",
      objective: "Preview failure should not crash",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "plan-opportunity-o1",
          kind: "planning" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Plan O1",
          prompt: "Create a plan artifact for accepted opportunity O1.",
          dependsOn: [],
          gates: ["verification" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const adapter = Object.assign(
      async () => ({ status: "passed" as const, output: "planned" }),
      {
        async prepareExecution() {
          throw new Error("preview resolver failed");
        },
      },
    );
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: adapter,
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("passed");
    expect(state.nodeResults[0]).toMatchObject({
      nodeId: "plan-opportunity-o1",
      status: "passed",
      output: "planned",
    });
  });

  it("skips conditional nodes when runWhen does not match and still completes downstream nodes", async () => {
    const plan = {
      id: "conditional-plan",
      objective: "Skip work",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "review",
          kind: "deliberation" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Review",
          prompt: "Review",
          dependsOn: [],
          gates: ["review-accepted" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
        {
          id: "implement",
          kind: "implementation" as const,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Implement",
          prompt: "Implement",
          dependsOn: ["review"],
          runWhen: { nodeId: "review", key: "finalRecommendationReview.status", equals: "accepted" },
          gates: ["verification" as const],
          writeMode: "single-writer" as const,
          replanPolicy: "never" as const,
        },
        {
          id: "report",
          kind: "report" as const,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Report",
          prompt: "Report",
          dependsOn: ["implement"],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const calls: string[] = [];
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: async (node) => {
        calls.push(node.id);
        return {
          status: "passed",
          output: "reviewed",
          payload: { finalRecommendationReview: { status: "rejected" } },
        };
      },
      [WorkflowHarnessKind.REPORTER]: async (node) => {
        calls.push(node.id);
        return { status: "passed", output: "report" };
      },
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("passed");
    expect(calls).toEqual(["review", "report"]);
    expect(state.nodeResults.find((result) => result.nodeId === "implement")?.status).toBe("skipped");
  });

  it("appends dynamic nodes after a successful node and emits replay additions before continuing", async () => {
    const plan = {
      id: "dynamic-plan",
      objective: "Expand after council",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "council-review",
          kind: "deliberation" as const,
          harness: WorkflowHarnessKind.DECISION_COUNCIL,
          title: "Council",
          prompt: "Council",
          dependsOn: [],
          gates: ["review-accepted" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const replayKinds: string[] = [];
    const replayNodes: Array<{ id?: string; description?: string; model?: string }> = [];
    const calls: string[] = [];
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.DECISION_COUNCIL]: async (node) => {
        calls.push(node.id);
        return { status: "passed", output: "council", payload: { ready: true } };
      },
      [WorkflowHarnessKind.REPORTER]: async (node) => {
        calls.push(node.id);
        return { status: "passed", output: "report" };
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: ({ node }) => node.id === "council-review"
        ? [{
          id: "report",
          kind: "report",
          harness: WorkflowHarnessKind.REPORTER,
          title: "Report",
          description: "Publish dynamic report.",
          model: "deterministic",
          prompt: "Report",
          dependsOn: ["council-review"],
          gates: ["output-contract"],
          writeMode: "read-only",
          replanPolicy: "never",
        }]
        : undefined,
      onReplayEvent(event) {
        replayKinds.push(event.kind);
        if (event.node) {
          replayNodes.push({
            id: event.node.id,
            description: event.node.description,
            model: event.node.model,
          });
        }
      },
    });

    expect(state.status).toBe("passed");
    expect(state.currentPlan.nodes.map((node) => node.id)).toEqual(["council-review", "report"]);
    expect(calls).toEqual(["council-review", "report"]);
    expect(replayNodes).toContainEqual({
      id: "report",
      description: "Publish dynamic report.",
      model: "deterministic",
    });
    expect(replayKinds).toEqual([
      "planning-started",
      "node-added",
      "planning-complete",
      "node-status-changed",
      "node-status-changed",
      "node-added",
      "node-status-changed",
      "node-status-changed",
      "run-completed",
    ]);
  });

  it("runs dynamically expanded independent nodes in parallel", async () => {
    const plan = {
      id: "dynamic-parallel-plan",
      objective: "Expand parallel opportunity plans",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "council-review",
          kind: "deliberation" as const,
          harness: WorkflowHarnessKind.DECISION_COUNCIL,
          title: "Council",
          prompt: "Council",
          dependsOn: [],
          gates: ["review-accepted" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const activePlanNodes = new Set<string>();
    let maxConcurrentPlanNodes = 0;
    const startedPlanNodes: string[] = [];
    const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.DECISION_COUNCIL]: async () => ({ status: "passed", output: "council" }),
      [WorkflowHarnessKind.COPILOT_SDK]: async (node) => {
        activePlanNodes.add(node.id);
        startedPlanNodes.push(node.id);
        maxConcurrentPlanNodes = Math.max(maxConcurrentPlanNodes, activePlanNodes.size);
        await delay();
        activePlanNodes.delete(node.id);
        return { status: "passed", output: `planned ${node.id}` };
      },
      [WorkflowHarnessKind.REPORTER]: async () => ({ status: "passed", output: "report" }),
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: ({ node }) => node.id === "council-review"
        ? [
          ...[
            "alpha",
            "beta",
            "gamma",
          ].map((id) => ({
            id: `plan-opportunity-${id}`,
            kind: "planning" as const,
            harness: WorkflowHarnessKind.COPILOT_SDK,
            title: `Plan ${id}`,
            prompt: `Plan ${id}`,
            dependsOn: ["council-review"],
            gates: ["verification" as const],
            writeMode: "read-only" as const,
            replanPolicy: "never" as const,
          })),
          {
            id: "report",
            kind: "report" as const,
            harness: WorkflowHarnessKind.REPORTER,
            title: "Report",
            prompt: "Report",
            dependsOn: ["plan-opportunity-alpha", "plan-opportunity-beta", "plan-opportunity-gamma"],
            gates: ["output-contract" as const],
            writeMode: "read-only" as const,
            replanPolicy: "never" as const,
          },
        ]
        : undefined,
    });

    expect(state.status).toBe("passed");
    expect(startedPlanNodes).toHaveLength(3);
    expect(maxConcurrentPlanNodes).toBe(3);
  });

  it("records thrown harness errors as failed node and run state", async () => {
    const plan = {
      id: "failing-plan",
      objective: "Surface failures",
      templateId: "implementation-review",
      maxReplans: 0,
      nodes: [
        {
          id: "research",
          kind: "research" as const,
          harness: WorkflowHarnessKind.RESEARCH,
          title: "Research",
          prompt: "Research",
          dependsOn: [],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const events: string[] = [];
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.RESEARCH]: async () => {
        throw new Error("Model unavailable");
      },
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      onStateChange: (nextState, event) => {
        events.push(`${event.type}:${nextState.status}:${nextState.nodeResults[0]?.status ?? "none"}`);
      },
    });

    expect(state.status).toBe("failed");
    expect(state.nodeResults).toEqual([
      expect.objectContaining({
        nodeId: "research",
        status: "failed",
        error: "Model unavailable",
      }),
    ]);
    expect(events).toContain("macro-workflow.node.failed:running:failed");
    expect(events).toContain("macro-workflow.run.completed:failed:failed");
  });
});
