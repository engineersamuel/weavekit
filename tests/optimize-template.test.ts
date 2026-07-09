import { describe, expect, it } from "vitest";
import { parseOptimizeTemplateArgs } from "../scripts/optimize-template.js";

const requiredArgs = ["--template", "source-to-project", "--mode", "advisory"];

describe("optimize-template args", () => {
  it("accepts the checked-in BAML default model flags", () => {
    expect(
      parseOptimizeTemplateArgs([
        ...requiredArgs,
        "--judge-model",
        "gpt-5.5",
        "--generator-model",
        "gpt-5.5",
      ]),
    ).toMatchObject({
      judgeModel: "gpt-5.5",
      generatorModel: "gpt-5.5",
    });
  });

  it("defaults to one live trial and accepts explicit live gate thresholds", () => {
    expect(parseOptimizeTemplateArgs(requiredArgs)).toMatchObject({
      maxLiveTrials: 1,
      minLiveDelta: 0.1,
      minLiveDecisionConfidence: 0.6,
    });

    expect(
      parseOptimizeTemplateArgs([
        ...requiredArgs,
        "--max-live-trials",
        "2",
        "--min-live-delta",
        "0.25",
        "--min-live-decision-confidence",
        "0.75",
      ]),
    ).toMatchObject({
      maxLiveTrials: 2,
      minLiveDelta: 0.25,
      minLiveDecisionConfidence: 0.75,
    });
  });

  it("bounds the live trial budget for cost control", () => {
    expect(() => parseOptimizeTemplateArgs([...requiredArgs, "--max-live-trials", "6"])).toThrow(
      "--max-live-trials must be an integer between 0 and 5.",
    );
  });

  it("rejects non-default model flags until BAML override wiring exists", () => {
    expect(() => parseOptimizeTemplateArgs([...requiredArgs, "--judge-model", "gpt-5.4"])).toThrow(
      "--judge-model only supports gpt-5.5 until BAML model override wiring exists.",
    );

    expect(() =>
      parseOptimizeTemplateArgs([...requiredArgs, "--generator-model", "claude-opus-4.8"]),
    ).toThrow("--generator-model only supports gpt-5.5 until BAML model override wiring exists.");
  });
});
