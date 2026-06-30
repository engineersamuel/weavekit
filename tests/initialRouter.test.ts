import { describe, expect, it } from "vitest";
import { Classifier, createInitialWorkflowRouter } from "../src/initialRouter.js";

describe("InitialWorkflowRouter", () => {
  it("routes planning-heavy prompts to plan mode", async () => {
    const router = createInitialWorkflowRouter();
    const decision = await router.route({
      prompt: "Create a rollout plan for the new router and break it into milestones and implementation steps.",
    });

    expect(decision.route).toBe(Classifier.PLAN);
    expect(decision.consideration).toContain("plan mode");
    expect(decision.needsElicitation).toBe(false);
  });

  it("routes research-heavy prompts to deep research", async () => {
    const router = createInitialWorkflowRouter();
    const decision = await router.route({
      prompt: "Research the current state of deep research connectors and compare the options with evidence from source docs.",
    });

    expect(decision.route).toBe(Classifier.RESEARCH);
    expect(decision.consideration).toContain("deep research");
  });

  it("routes decision questions to the decision council", async () => {
    const router = createInitialWorkflowRouter();
    const decision = await router.route({
      prompt: "Should we use the decision council or plan mode for this design challenge? We need a recommendation with trade-offs.",
    });

    expect(decision.route).toBe("decision-council");
    expect(decision.consideration).toContain("decision council");
  });

  it("routes underspecified prompts to elicitation", async () => {
    const router = createInitialWorkflowRouter();
    const decision = await router.route({
      prompt: "Need help with this.",
    });

    expect(decision.route).toBe("elicitation");
    expect(decision.needsElicitation).toBe(true);
  });

  it("falls back to direct when no strong signal exists", async () => {
    const router = createInitialWorkflowRouter();
    const decision = await router.route({
      prompt: "Summarize the API docs in one paragraph.",
    });

    expect(decision.route).toBe("direct");
    expect(decision.needsElicitation).toBe(false);
  });
});
