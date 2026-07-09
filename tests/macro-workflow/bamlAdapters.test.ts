import { describe, expect, it } from "vitest";
import { GeneratedWorkflowPlannerAdapter } from "../../src/macro-workflow/bamlAdapters.js";

describe("macro workflow planner adapter seam", () => {
  it("uses the generated client for planning and replanning", async () => {
    const calls: Array<{ operation: string; options: unknown }> = [];
    const planner = new GeneratedWorkflowPlannerAdapter({
      plannerClient: {
        async PlanWorkflow(
          objective: string,
          prompt: string,
          templateId: string,
          options: unknown,
        ) {
          calls.push({ operation: `plan:${templateId}`, options });
          return {
            objective,
            templateId,
            maxReplans: 1,
            nodes: [
              {
                id: "research",
                kind: "research",
                harness: "research",
                title: "Research",
                description: "Research description",
                model: "gpt-5.4",
                modelRationale: "Fixture policy.",
                prompt,
                dependsOn: [],
                gates: ["output-contract"],
                writeMode: "read-only",
                replanPolicy: "on-contract-failure",
              },
            ],
          };
        },
        async GenerateReplanPatch(
          reason: string,
          maxRemainingReplans: number,
          _completedNodeIds: string[] | undefined,
          _currentPlan: unknown,
          options: unknown,
        ) {
          calls.push({ operation: `replan:${reason}:${maxRemainingReplans}`, options });
          return {
            reason,
            replaceRemainingNodeIds: [],
            newNodes: [],
          };
        },
      } as never,
    });

    const plan = await planner.planWorkflow({
      objective: "Ship the feature",
      prompt: "Do the work",
      templateId: "implementation-review",
    });
    const patch = await planner.generateReplanPatch({
      reason: "verification-failure",
      maxRemainingReplans: 1,
    });

    expect(plan.templateId).toBe("implementation-review");
    expect(plan.nodes[0]).toMatchObject({
      description: "Research description",
      model: "gpt-5.4",
      modelRationale: "Fixture policy.",
    });
    expect(patch.reason).toBe("verification-failure");
    expect(calls).toEqual([
      { operation: "plan:implementation-review", options: { client: "CopilotProxyGpt55" } },
      {
        operation: "replan:verification-failure:1",
        options: { client: "CopilotProxyClaudeOpus48" },
      },
    ]);
  });

  it("binds planner methods so generated BAML clients keep their instance context", async () => {
    const plannerClient = {
      invoked: true,
      async PlanWorkflow(
        this: { invoked: boolean },
        objective: string,
        prompt: string,
        templateId: string,
      ) {
        expect(this.invoked).toBe(true);
        return {
          objective,
          templateId,
          maxReplans: 0,
          nodes: [],
        };
      },
    };
    const planner = new GeneratedWorkflowPlannerAdapter({ plannerClient: plannerClient as never });

    await expect(
      planner.planWorkflow({
        objective: "Ship the feature",
        prompt: "Do the work",
        templateId: "implementation-review",
      }),
    ).resolves.toMatchObject({
      templateId: "implementation-review",
    });
  });

  it("passes completed-node and current-plan context to the replanner seam", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const planner = new GeneratedWorkflowPlannerAdapter({
      plannerClient: {
        async GenerateReplanPatch(
          reason: string,
          maxRemainingReplans: number,
          completedNodeIds: string[] | undefined,
          currentPlan: unknown,
        ) {
          seen.push({ reason, maxRemainingReplans, completedNodeIds, currentPlan });
          return {
            reason,
            replaceRemainingNodeIds: [],
            newNodes: [],
          };
        },
      } as never,
    });

    const currentPlan = {
      id: "plan-1",
      objective: "Ship the feature",
      templateId: "implementation-review",
      maxReplans: 1,
      nodes: [],
    };

    await planner.generateReplanPatch({
      reason: "verification-failure",
      maxRemainingReplans: 1,
      completedNodeIds: ["research"],
      currentPlan,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      reason: "verification-failure",
      maxRemainingReplans: 1,
      completedNodeIds: ["research"],
      currentPlan,
    });
  });

  it("calls the planner with positional arguments to match the generated BAML signature", async () => {
    const seen: unknown[][] = [];
    const planner = new GeneratedWorkflowPlannerAdapter({
      plannerClient: {
        async PlanWorkflow(...args: unknown[]) {
          seen.push(args);
          return {
            objective: String(args[0]),
            templateId: String(args[2]),
            maxReplans: 0,
            nodes: [],
          };
        },
      } as never,
    });

    await planner.planWorkflow({
      objective: "Ship the feature",
      prompt: "Do the work",
      templateId: "implementation-review",
    });

    expect(seen).toEqual([
      ["Ship the feature", "Do the work", "implementation-review", { client: "CopilotProxyGpt55" }],
    ]);
  });

  it("infers description and model metadata for BAML-normalized nodes that omit it", async () => {
    const planner = new GeneratedWorkflowPlannerAdapter({
      plannerClient: {
        async PlanWorkflow(objective: string, prompt: string, templateId: string) {
          return {
            objective,
            templateId,
            maxReplans: 0,
            nodes: [
              {
                id: "plan",
                kind: "planning",
                harness: "copilot-sdk",
                title: "Plan",
                prompt: "Plan the work",
                dependsOn: [],
                gates: ["output-contract"],
                writeMode: "read-only",
                replanPolicy: "never",
              },
              {
                id: "implement",
                kind: "implementation",
                harness: "copilot-sdk",
                title: "Implement",
                prompt,
                dependsOn: [],
                gates: ["verification"],
                writeMode: "single-writer",
                replanPolicy: "on-verification-failure",
              },
              {
                id: "verify",
                kind: "verification",
                harness: "verifier",
                title: "Verify",
                prompt: "Verify",
                dependsOn: ["implement"],
                gates: ["verification"],
                writeMode: "read-only",
                replanPolicy: "never",
              },
            ],
          };
        },
      } as never,
    });

    const plan = await planner.planWorkflow({
      objective: "Ship",
      prompt: "Do the work",
      templateId: "implementation-review",
    });

    expect(plan.nodes.find((node) => node.id === "plan")).toMatchObject({
      description: "Plan the work",
      model: "claude-opus-4.8",
    });
    expect(plan.nodes.find((node) => node.id === "implement")).toMatchObject({
      description: "Do the work",
      model: "gpt-5.3-codex",
    });
    expect(plan.nodes.find((node) => node.id === "verify")).toMatchObject({
      model: "deterministic",
    });
  });
});
