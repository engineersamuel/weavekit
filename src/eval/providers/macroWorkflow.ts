import type { RuntimeWorkflowPlan } from "../../macro-workflow/types.js";
import { materializeWorkflowPlan } from "../../macro-workflow/templates.js";
import { verifyWorkflowPlan } from "../../macro-workflow/verifier.js";

export type MacroWorkflowProviderInput = {
  prompt: string;
  objective?: string;
  templateId?: string;
};

export type MacroWorkflowProviderDeps = {
  planWorkflow?: (input: MacroWorkflowProviderInput) => Promise<RuntimeWorkflowPlan>;
};

export type MacroWorkflowProviderResult = {
  plan: RuntimeWorkflowPlan;
  verification: ReturnType<typeof verifyWorkflowPlan>;
};

export class MacroWorkflowProvider {
  constructor(private readonly deps: MacroWorkflowProviderDeps = {}) {}

  async provide(input: MacroWorkflowProviderInput): Promise<MacroWorkflowProviderResult> {
    const objective = input.objective ?? input.prompt;
    const templateId = input.templateId ?? "implementation-review";
    const plan = this.deps.planWorkflow
      ? await this.deps.planWorkflow({ prompt: input.prompt, objective, templateId })
      : materializeWorkflowPlan(templateId as "implementation-review", objective);
    const verification = verifyWorkflowPlan(plan);
    return { plan, verification };
  }

  async callApi(_prompt: string, context?: { vars?: Record<string, string> }): Promise<{ output: string; metadata: Record<string, unknown> }> {
    const input = {
      prompt: context?.vars?.prompt ?? _prompt,
      objective: context?.vars?.prompt ?? _prompt,
      templateId: "implementation-review",
    };
    const result = await this.provide(input);
    return {
      output: `Template: ${result.plan.templateId}\nNode count: ${result.plan.nodes.length}\nValidation: ${result.verification.valid ? "valid" : "invalid"}`,
      metadata: { templateId: result.plan.templateId, valid: result.verification.valid, issueCount: result.verification.issues.length },
    };
  }
}
