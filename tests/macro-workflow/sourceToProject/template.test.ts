import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import { verifyWorkflowPlan } from "../../../src/macro-workflow/verifier.js";

describe("source-to-project template", () => {
  it("requires project brief distillation to preserve exact public interfaces", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");

    expect(source).toContain("Preserve exact public interface literals");
    expect(source).toContain("Omit a validation command rather than guessing");
    expect(source).toContain(
      "Missing implementation or test coverage is evidence for adoption, not contradiction",
    );
    expect(source).toContain(
      "Preserve exact contributor and operator documentation paths and conventions",
    );
    expect(source).toContain("stale or conflicting commands");
    expect(source).toContain("Never invent a documentation location or convention");
  });

  it("repairs every audited portfolio clause from immutable grounded context", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");
    const auditPrompt = source.slice(
      source.indexOf("function AuditPortfolioCoverage"),
      source.indexOf("function RepairPortfolioPlan"),
    );
    const repairPrompt = source.slice(
      source.indexOf("function RepairPortfolioPlan"),
      source.indexOf("function ReviewFinalRecommendation"),
    );

    expect(auditPrompt).toContain(
      "Distinguish established current-state claims from clearly labeled implementation proposals",
    );
    expect(auditPrompt).toContain(
      "Do not mark a proposed new file, path, or identifier unsupported solely because it does not already exist",
    );
    expect(auditPrompt).toContain(
      "bounded implementation choice inside a project-evidenced target layer or change surface",
    );
    expect(auditPrompt).toContain(
      "Continue to reject invented current-state facts, existing-path claims, source requirements, and project surfaces",
    );
    expect(repairPrompt).toContain(
      "Locate its full immutable behavior or obligation description and its semantic audit rationale and gaps",
    );
    expect(repairPrompt).toContain(
      "Split every conjunction, list item, and parenthetical clause into a checklist",
    );
    expect(repairPrompt).toContain(
      "Add a correct-layer implementable action and explicit proof for every missing clause",
    );
    expect(repairPrompt).toContain(
      "Remove or qualify every unsupported claim and resolve every contradiction",
    );
    expect(repairPrompt).toContain(
      "Treat every semanticAudit.unsupportedClaims entry as an exhaustive repair checklist",
    );
    expect(repairPrompt).toContain(
      "Locate every repeated occurrence and variant of each flagged claim in both markdown and coverage claims",
    );
    expect(repairPrompt).toContain(
      "rewrite it as an explicit implementation-time verification gate",
    );
    expect(repairPrompt).toContain(
      "inspect current behavior, then preserve or adapt based on the observed result",
    );
    expect(repairPrompt).toContain(
      "must not repeat the precise ungrounded value or path anywhere in the repaired draft, even when qualified",
    );
    expect(repairPrompt).toContain(
      "Use generic wording such as inspect and record the observed current behavior or implementation",
    );
    expect(repairPrompt).toContain(
      "For clearly proposed new files within evidenced layers, label them as proposed and bounded",
    );
    expect(repairPrompt).toContain(
      "Before returning, scan the fresh draft so none of the flagged unsupported current-state values or paths remain anywhere",
    );
    expect(repairPrompt).toContain(
      "For canonical-location, use only exact project-evidenced documentation paths",
    );
    expect(repairPrompt).toContain("Never invent a fallback or call the plan canonical");
    expect(repairPrompt).toContain("fail closed rather than inventing one");
    expect(repairPrompt.indexOf("exhaustive repair checklist")).toBeLessThan(
      repairPrompt.indexOf("Locate every repeated occurrence"),
    );
    expect(repairPrompt.indexOf("Locate every repeated occurrence")).toBeLessThan(
      repairPrompt.indexOf("Before returning, scan the fresh draft"),
    );
  });

  it("requires the initial portfolio audit to ground canonical documentation location", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");
    const auditPrompt = source.slice(
      source.indexOf("function AuditPortfolioCoverage"),
      source.indexOf("function RepairPortfolioPlan"),
    );

    expect(auditPrompt).toContain(
      "Mark canonical-location complete only when the draft uses an exact project-evidenced documentation path from compilerJson",
    );
    expect(auditPrompt).toContain(
      "Invented paths, generic fallbacks, PR links without project evidence, or merely calling the plan canonical must remain non-complete",
    );
    expect(auditPrompt).toContain("Record those claims in unsupportedClaims");
  });

  it("gives portfolio draft extraction one bounded evidence repair contract", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");
    const extractionPrompt = source.slice(
      source.indexOf("function DistillPortfolioPlanDraft"),
      source.indexOf("function AuditPortfolioCoverage"),
    );

    expect(extractionPrompt).toContain(
      "function DistillPortfolioPlanDraft(compilerJson: string, planMarkdown: string, validationFeedback: string)",
    );
    expect(extractionPrompt).toContain("Return a fresh complete draft, not a patch");
    expect(extractionPrompt).toContain("Preserve planMarkdown byte-for-byte in markdown");
    expect(extractionPrompt).toContain(
      "Delete invalid evidence quotes rather than normalizing or reconstructing them",
    );
    expect(extractionPrompt).toContain(
      "copy at least one complete contiguous line or sentence byte-for-byte, including every Markdown marker",
    );
    expect(extractionPrompt).toContain("`**Heading.** Next` cannot be returned as `Heading. Next`");
    expect(extractionPrompt).toContain("{{ validationFeedback }}");
    expect(extractionPrompt).toContain("{{ ctx.output_format }}");
  });

  it("teaches applicability repair to preserve partitions for conditional parity checks", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");
    const repairPrompt = source.slice(
      source.indexOf("function RepairProjectApplicability"),
      source.indexOf("function MapSourceToProject"),
    );

    expect(repairPrompt).toContain(
      "For applicable, all behavior IDs are applicable. For partial, partition behavior IDs between applicable and excluded. For not-applicable or unknown, put every behavior ID in excludedBehaviorIds.",
    );
    expect(repairPrompt).toContain(
      "When direct project evidence identifies an existing compatibility risk but confirmation requires a bounded parity check, treat the evidence-gated conditional work as applicable.",
    );
    expect(repairPrompt).toContain(
      "Make the action conditional on that proof and do not claim the risk is already realized.",
    );
  });

  it("materializes the advisory source-to-project DAG", () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Learn from a source",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "advisory",
    });

    expect(plan.templateId).toBe("source-to-project");
    expect(plan.nodes.map((node) => node.id)).toEqual([
      "visual-plan-preflight",
      "source-reading",
      "source-corroboration",
      "project-research",
      "opportunity-mapping",
      "council-review",
    ]);
    expect(plan.nodes.find((node) => node.id === "visual-plan-preflight")).toMatchObject({
      kind: "verification",
      harness: "copilot-sdk",
      title: "Verify visual-plan capability",
      dependsOn: [],
      model: "deterministic",
    });
    expect(plan.nodes.find((node) => node.id === "source-reading")?.dependsOn).toEqual([
      "visual-plan-preflight",
    ]);
    expect(plan.nodes.find((node) => node.id === "opportunity-mapping")?.dependsOn).toEqual([
      "source-reading",
      "source-corroboration",
      "project-research",
    ]);
    expect(plan.nodes.find((node) => node.id === "project-research")?.dependsOn).toEqual([
      "source-corroboration",
    ]);
    expect(plan.nodes.find((node) => node.id === "project-research")?.capabilities).toEqual({
      pluginCommands: [
        {
          plugin: "hve-core",
          command: "hve-core:task-research",
          promptInputName: "topic",
          args: { chat: "false", subagents: "false" },
        },
      ],
    });
    expect(plan.nodes.find((node) => node.id === "source-reading")).toMatchObject({
      description: expect.stringContaining("Read the source artifact"),
      model: "gpt-5.5",
    });
    expect(plan.nodes.find((node) => node.id === "council-review")).toMatchObject({
      model: "deterministic",
    });
    expect(plan.nodes.every((node) => node.writeMode === "read-only")).toBe(true);
    expect(verifyWorkflowPlan(plan).valid).toBe(true);
  });

  it("keeps autonomous source-to-project static planning bounded to council review", () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Learn from a source",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "autonomous-pr",
    });

    expect(plan.nodes.at(-1)?.id).toBe("council-review");
    expect(plan.nodes.some((node) => node.writeMode === "single-writer")).toBe(false);
  });

  it("supports bounded direct project research without the HVE command", () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Benchmark source transfer",
      source: "./source.md",
      projectPath: "./project",
      mode: "advisory",
      projectResearchMode: "direct",
    });

    expect(plan.nodes.find((node) => node.id === "project-research")?.capabilities).toBeUndefined();
    expect(verifyWorkflowPlan(plan).valid).toBe(true);
  });
});
