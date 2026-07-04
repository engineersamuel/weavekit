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
        "claude-opus-4.8",
      ]),
    ).toMatchObject({
      judgeModel: "gpt-5.5",
      generatorModel: "claude-opus-4.8",
    });
  });

  it("rejects non-default model flags until BAML override wiring exists", () => {
    expect(() =>
      parseOptimizeTemplateArgs([...requiredArgs, "--judge-model", "gpt-5.4"]),
    ).toThrow("--judge-model only supports gpt-5.5 until BAML model override wiring exists.");

    expect(() =>
      parseOptimizeTemplateArgs([...requiredArgs, "--generator-model", "gpt-5.5"]),
    ).toThrow(
      "--generator-model only supports claude-opus-4.8 until BAML model override wiring exists.",
    );
  });
});
