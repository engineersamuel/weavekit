import { describe, expect, it } from "vitest";
import { defaultWorkflowGrammar } from "../../../src/macro-workflow/grammar.js";
import { renderTemplateOptimizerConstraints } from "../../../src/macro-workflow/templateOptimizer/constraints.js";

describe("template optimizer constraints", () => {
  it("renders workflow grammar and source-to-project mode constraints", () => {
    const summary = renderTemplateOptimizerConstraints({
      grammar: defaultWorkflowGrammar,
      templateId: "source-to-project",
      mode: "advisory",
    });

    expect(summary).toContain("allowedNodeKinds");
    expect(summary).toContain("allowedHarnesses");
    expect(summary).toContain("implementationHarnesses");
    expect(summary).toContain("advisory mode must not include implementation nodes");
    expect(summary).toContain("final recommendation review");
  });

  it("renders autonomous-pr safety constraints", () => {
    const summary = renderTemplateOptimizerConstraints({
      grammar: defaultWorkflowGrammar,
      templateId: "source-to-project",
      mode: "autonomous-pr",
    });

    expect(summary).toContain("final recommendation review before implementation");
    expect(summary).toContain("autonomous-pr mode requires explicit enablement");
    expect(summary).toContain("worktree preparation must happen before writes");
    expect(summary).toContain("verification gates must run after writes");
    expect(summary).toContain("no merge or self-approval behavior is allowed");
  });
});
