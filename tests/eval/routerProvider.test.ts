import { describe, expect, it } from "vitest";
import { RouterRoute } from "../../src/config.js";
import { createHeuristicRouterAdvisor, RouterProvider } from "../../src/eval/providers/router.js";

describe("RouterProvider", () => {
  it("returns advisory metadata and text summary", async () => {
    const provider = new RouterProvider({
      advisor: {
        async advise() {
          return {
            route: RouterRoute.GOAL_PROMPT,
            harness: "copilot-cli",
            ability: "goal",
            model: "gpt-5.5",
            confidence: 0.9,
            rationale: "Durable goal requested.",
            promptRewrite: "/goal finish and verify the task.",
            alternatives: [RouterRoute.PLAN, RouterRoute.LOCAL_CODE_CHANGE],
            createWorktreeEligible: false,
            warnings: ["Do not finish without verification evidence."],
          };
        },
      },
    });

    const response = await provider.callApi("Keep working until done.");

    expect(response.error).toBeUndefined();
    expect(response.output).toContain("Route: goal-prompt");
    expect(response.output).toContain("Prompt rewrite: /goal finish and verify the task.");
    expect(response.output).toContain("Warnings: Do not finish without verification evidence.");
    expect(response.metadata).toMatchObject({
      route: "goal-prompt",
      harness: "copilot-cli",
      ability: "goal",
      promptRewrite: "/goal finish and verify the task.",
      createWorktreeEligible: false,
    });
  });

  it("routes every canonical corpus-style prompt to the expected route", async () => {
    const advisor = createHeuristicRouterAdvisor();
    const cases = [
      ["What does this error mean?", RouterRoute.DIRECT_ANSWER],
      ["Rewrite this prompt to be clearer.", RouterRoute.REFINE_PROMPT],
      ["Start /goal and keep working until done.", RouterRoute.GOAL_PROMPT],
      ["Create an implementation plan with milestones.", RouterRoute.PLAN],
      ["This is ambiguous and missing requirements.", RouterRoute.GRILL_WITH_DOCS],
      ["Research latest options with citations.", RouterRoute.RESEARCH],
      ["Fix the failing test in this local worktree.", RouterRoute.LOCAL_CODE_CHANGE],
      ["Use parallel subagents to decompose this audit.", RouterRoute.FLEET_PARALLEL],
      ["Delegate this to a remote PR coding agent.", RouterRoute.REMOTE_DELEGATE_PR],
      ["Use decision council to choose between approaches.", RouterRoute.DECISION_COUNCIL],
      ["Map this source artifact to the target project.", RouterRoute.SOURCE_TO_PROJECT],
      [
        "Create worktree with herdr. Project: weavekit Branch: advisory Agent: codex",
        RouterRoute.MANUAL_HERDR_WORKTREE,
      ],
      [
        "Create worktree with herdr to implement the router workflow. Project: weavekit Branch: advisory Agent: codex",
        RouterRoute.MANUAL_HERDR_WORKTREE,
      ],
    ] as const;

    for (const [prompt, route] of cases) {
      await expect(advisor.advise(prompt)).resolves.toMatchObject({
        route,
        promptRewrite: expect.stringMatching(/\S/u),
      });
    }
  });

  it.each([
    {
      name: "complete manual Herdr handoff",
      prompt:
        "Create worktree with herdr. Project: weavekit Branch: router Agent: codex. Implement the router workflow.",
      route: RouterRoute.MANUAL_HERDR_WORKTREE,
      alternatives: [RouterRoute.LOCAL_CODE_CHANGE],
      rationale: ["complete", "user-controlled"],
      rewrite: ["Herdr", "Project", "Branch", "Agent", "do not auto"],
      eligible: true,
    },
    {
      name: "goal prompt for a known outcome",
      prompt:
        "I want to migrate the auth flow. Write me the optimal /goal prompt with success criteria, constraints, and checkpoints. Do not start executing the goal.",
      route: RouterRoute.GOAL_PROMPT,
      alternatives: [RouterRoute.PLAN],
      rationale: ["known outcome", "do not execute"],
      rewrite: ["success criteria", "constraints", "checkpoints", "do not start"],
      eligible: false,
    },
    {
      name: "plan before goal mode",
      prompt:
        "Before we start, use /plan to map out the full approach for replacing the router. Then convert that plan into a /goal. Plan first; do not start goal mode yet.",
      route: RouterRoute.PLAN,
      alternatives: [RouterRoute.GOAL_PROMPT],
      rationale: ["first requested action", "plan"],
      rewrite: ["implementation plan", "goal-ready", "do not start"],
      eligible: false,
    },
    {
      name: "broad implicit context dump",
      prompt:
        "Based on everything you know about me, this codebase, and how I work, what /goal prompts should we build? Do not invent private memory or missing project priorities.",
      route: RouterRoute.GRILL_WITH_DOCS,
      alternatives: [RouterRoute.GOAL_PROMPT, RouterRoute.PLAN],
      rationale: ["implicit context", "do not invent"],
      rewrite: ["desired outcome", "relevant context", "success"],
      eligible: false,
    },
    {
      name: "vague goal request",
      prompt: "Make this better and write the goal.",
      route: RouterRoute.GRILL_WITH_DOCS,
      alternatives: [RouterRoute.GOAL_PROMPT],
      rationale: ["not enough context", "do not invent"],
      rewrite: ["what should be improved", "success"],
      eligible: false,
    },
    {
      name: "ambiguous execution location",
      prompt: "Can you handle this change in the best place?",
      route: RouterRoute.GRILL_WITH_DOCS,
      alternatives: [RouterRoute.PLAN],
      rationale: ["local, remote, or manual", "do not guess"],
      rewrite: ["target", "exact change", "execution mode"],
      eligible: false,
    },
  ])(
    "provides contextual advice for $name",
    async ({ prompt, route, alternatives, rationale, rewrite, eligible }) => {
      const result = await createHeuristicRouterAdvisor().advise(prompt);

      expect(result.route).toBe(route);
      expect(result.createWorktreeEligible).toBe(eligible);
      expect(result.alternatives).toEqual(expect.arrayContaining(alternatives));
      for (const phrase of rationale) {
        expect(result.rationale.toLowerCase()).toContain(phrase.toLowerCase());
      }
      for (const phrase of rewrite) {
        expect(result.promptRewrite.toLowerCase()).toContain(phrase.toLowerCase());
      }
    },
  );

  it.each([
    {
      prompt: "Run source-to-project for my project.",
      route: RouterRoute.SOURCE_TO_PROJECT,
      alternative: RouterRoute.GRILL_WITH_DOCS,
      rewrite: ["source artifact", "target project"],
      warning: "do not invent",
    },
    {
      prompt: "Delegate this cleanup to a cloud coding agent and have it open a PR.",
      route: RouterRoute.REMOTE_DELEGATE_PR,
      alternative: RouterRoute.LOCAL_CODE_CHANGE,
      rewrite: ["remote coding agent", "pull request", "repository"],
      warning: "current worktree",
    },
    {
      prompt: "Rewrite my prompt for a Copilot coding agent, but don't run it.",
      route: RouterRoute.REFINE_PROMPT,
      alternative: RouterRoute.REMOTE_DELEGATE_PR,
      rewrite: ["Copilot coding agent", "do not run"],
      warning: "do not start",
    },
    {
      prompt:
        "This touches BAML, CLI, tests, dashboard, and docs; split it across independent workers.",
      route: RouterRoute.FLEET_PARALLEL,
      alternative: RouterRoute.LOCAL_CODE_CHANGE,
      rewrite: ["independent workers", "non-overlapping", "BAML, CLI, tests, dashboard, and docs"],
      warning: "duplicate",
    },
  ])(
    "preserves explicit $route intent while adding safe handoff guidance",
    async ({ prompt, route, alternative, rewrite, warning }) => {
      const result = await createHeuristicRouterAdvisor().advise(prompt);

      expect(result.route).toBe(route);
      expect(result.alternatives).toContain(alternative);
      for (const phrase of rewrite) {
        expect(result.promptRewrite.toLowerCase()).toContain(phrase.toLowerCase());
      }
      expect((result.warnings ?? []).join(" ").toLowerCase()).toContain(warning.toLowerCase());
    },
  );
});
