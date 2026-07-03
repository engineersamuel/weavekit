import { describe, expect, it } from "vitest";
import {
  SOURCE_TO_PROJECT_BAML_FUNCTION_OPERATIONS,
  SourceToProjectModelOperation,
  sourceToProjectBamlFunctionRoute,
  sourceToProjectBamlRoute,
  sourceToProjectCopilotModelDecision,
  sourceToProjectModelDecision,
  sourceToProjectNodeModelMetadata,
} from "../../../src/macro-workflow/sourceToProject/modelPolicy.js";

describe("source-to-project model policy", () => {
  it("routes default operations to contextual models", () => {
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.SOURCE_READING)).toMatchObject({
      model: "gpt-5.5",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.PLAN_DISTILLATION)).toMatchObject({
      model: "gpt-5-mini",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.PLAN_GENERATION)).toMatchObject({
      model: "claude-opus-4.8",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.VISUAL_DESIGN)).toMatchObject({
      model: "claude-opus-4.8",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.IMPLEMENTATION)).toMatchObject({
      model: "gpt-5.3-codex",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.IMPLEMENTATION_FIX)).toMatchObject({
      model: "gpt-5.5",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.IMPLEMENTATION_REVIEW)).toMatchObject({
      model: "gpt-5.5",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.WORKFLOW_PLANNING)).toMatchObject({
      model: "claude-opus-4.8",
    });
    expect(sourceToProjectModelDecision(SourceToProjectModelOperation.DETERMINISTIC)).toMatchObject({
      model: "deterministic",
    });
  });

  it("applies source_to_project.copilot_model only to Copilot SDK decisions", () => {
    const config = { copilotModel: "copilot-override" };

    expect(sourceToProjectCopilotModelDecision(SourceToProjectModelOperation.SOURCE_READING, config)).toMatchObject({
      model: "copilot-override",
    });
    expect(sourceToProjectCopilotModelDecision(SourceToProjectModelOperation.PROJECT_RESEARCH, config)).toMatchObject({
      model: "copilot-override",
    });
    expect(sourceToProjectBamlRoute(SourceToProjectModelOperation.SOURCE_READING, {})).toMatchObject({
      model: "gpt-5.5",
      client: "CopilotProxyGpt55",
    });
  });

  it("routes target project Copilot SDK research to Sonnet without changing BAML project distillation", () => {
    expect(sourceToProjectCopilotModelDecision(SourceToProjectModelOperation.PROJECT_RESEARCH)).toMatchObject({
      model: "claude-sonnet-5",
    });
    expect(sourceToProjectBamlFunctionRoute("DistillProjectBrief")).toMatchObject({
      model: "gpt-5.5",
      client: "CopilotProxyGpt55",
    });
  });

  it("uses execution-route metadata for source-to-project node cards", () => {
    const options = { copilotModel: "copilot-override", env: { BAML_MODEL: "baml-override" } };

    expect(sourceToProjectNodeModelMetadata(SourceToProjectModelOperation.SOURCE_READING, options)).toMatchObject({
      model: "copilot-override",
    });
    expect(sourceToProjectNodeModelMetadata(SourceToProjectModelOperation.PLAN_GENERATION, options)).toMatchObject({
      model: "copilot-override",
    });
    expect(sourceToProjectNodeModelMetadata(SourceToProjectModelOperation.OPPORTUNITY_MAPPING, options)).toMatchObject({
      model: "baml-override",
    });
    expect(sourceToProjectNodeModelMetadata(SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW, options)).toMatchObject({
      model: "baml-override",
    });
    expect(sourceToProjectNodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC, options)).toMatchObject({
      model: "deterministic",
    });
  });

  it("maps known BAML_MODEL values to generated clients and marks unknown values for runtime registry routing", () => {
    expect(sourceToProjectBamlRoute(SourceToProjectModelOperation.PLAN_DISTILLATION, { BAML_MODEL: "gpt-5-mini" })).toMatchObject({
      model: "gpt-5-mini",
      client: "CopilotProxyGpt5Mini",
    });
    expect(sourceToProjectBamlRoute(SourceToProjectModelOperation.WORKFLOW_PLANNING, { BAML_MODEL: "claude-opus-4.8" })).toMatchObject({
      model: "claude-opus-4.8",
      client: "CopilotProxyClaudeOpus48",
    });

    expect(sourceToProjectBamlRoute(SourceToProjectModelOperation.PLAN_DISTILLATION, { BAML_MODEL: "custom-model" })).toMatchObject({
      model: "custom-model",
      client: undefined,
    });
  });

  it("maps every source-to-project BAML function to the client for its model policy", () => {
    expect(SOURCE_TO_PROJECT_BAML_FUNCTION_OPERATIONS).toEqual({
      DistillSourceAnalysis: SourceToProjectModelOperation.SOURCE_READING,
      DistillCorroboration: SourceToProjectModelOperation.SOURCE_CORROBORATION,
      DistillProjectBrief: SourceToProjectModelOperation.PROJECT_RESEARCH,
      MapSourceToProject: SourceToProjectModelOperation.OPPORTUNITY_MAPPING,
      DistillPlanArtifact: SourceToProjectModelOperation.PLAN_DISTILLATION,
      ReviewFinalRecommendation: SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW,
    });

    expect(sourceToProjectBamlFunctionRoute("DistillSourceAnalysis")).toMatchObject({
      model: "gpt-5.5",
      client: "CopilotProxyGpt55",
    });
    expect(sourceToProjectBamlFunctionRoute("DistillCorroboration")).toMatchObject({
      model: "gpt-5.5",
      client: "CopilotProxyGpt55",
    });
    expect(sourceToProjectBamlFunctionRoute("DistillProjectBrief")).toMatchObject({
      model: "gpt-5.5",
      client: "CopilotProxyGpt55",
    });
    expect(sourceToProjectBamlFunctionRoute("MapSourceToProject")).toMatchObject({
      model: "claude-opus-4.8",
      client: "CopilotProxyClaudeOpus48",
    });
    expect(sourceToProjectBamlFunctionRoute("DistillPlanArtifact")).toMatchObject({
      model: "gpt-5-mini",
      client: "CopilotProxyGpt5Mini",
    });
    expect(sourceToProjectBamlFunctionRoute("ReviewFinalRecommendation")).toMatchObject({
      model: "gpt-5.5",
      client: "CopilotProxyGpt55",
    });
  });
});
