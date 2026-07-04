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

  it("rejects non-default model flags until BAML override wiring exists", () => {
    expect(() =>
      parseOptimizeTemplateArgs([...requiredArgs, "--judge-model", "gpt-5.4"]),
    ).toThrow("--judge-model only supports gpt-5.5 until BAML model override wiring exists.");

    expect(() =>
      parseOptimizeTemplateArgs([...requiredArgs, "--generator-model", "claude-opus-4.8"]),
    ).toThrow(
      "--generator-model only supports gpt-5.5 until BAML model override wiring exists.",
    );
  });
});
