import { describe, expect, it } from "vitest";
import { parseRlmCliArgs } from "../../src/rlm-poc/cli.js";

describe("parseRlmCliArgs", () => {
  it("keeps the no-argument validation mode", () => {
    expect(parseRlmCliArgs([])).toEqual({ trellage: false, eagerWorktree: false, help: false });
  });

  it.each([
    [["-p", "Use the council profile."], "Use the council profile."],
    [["--prompt", "Research this topic."], "Research this topic."],
    [["--prompt=Implement this carefully."], "Implement this carefully."],
  ])("parses a custom prompt from %j", (args, expected) => {
    expect(parseRlmCliArgs(args)).toEqual({
      prompt: expected,
      trellage: false,
      eagerWorktree: false,
      help: false,
    });
  });

  it.each([
    [["--resume", "f13c1665-bc2c-4d97-9c37-8f31d5c87d17"], "Continue the work."],
    [["--resume=f13c1665-bc2c-4d97-9c37-8f31d5c87d17"], "Use the prior context."],
  ])("parses resume arguments from %j", (resumeArgs, prompt) => {
    expect(parseRlmCliArgs([...resumeArgs, "--prompt", prompt])).toEqual({
      prompt,
      resume: "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
      trellage: false,
      eagerWorktree: false,
      help: false,
    });
  });

  it("enables trellage delegation and eager worktree provisioning", () => {
    expect(parseRlmCliArgs(["--trellage", "--eager-worktree", "-p", "Do the work."])).toEqual({
      prompt: "Do the work.",
      trellage: true,
      eagerWorktree: true,
      help: false,
    });
  });

  it("enables explicit reuse of the current Herdr worktree", () => {
    expect(
      parseRlmCliArgs(["--trellage", "--reuse-current-worktree", "-p", "Do the work."]),
    ).toEqual({
      prompt: "Do the work.",
      trellage: true,
      eagerWorktree: false,
      reuseCurrentWorktree: true,
      help: false,
    });
  });

  it.each([
    [["--cwd", "/tmp/worktree"], "/tmp/worktree"],
    [["--cwd=/tmp/worktree"], "/tmp/worktree"],
  ])("parses a custom working directory from %j", (cwdArgs, expected) => {
    expect(parseRlmCliArgs([...cwdArgs, "-p", "Do the work."])).toEqual({
      prompt: "Do the work.",
      cwd: expected,
      trellage: false,
      eagerWorktree: false,
      help: false,
    });
  });

  it("parses runtime model and budget controls", () => {
    expect(
      parseRlmCliArgs([
        "--model",
        "gpt-5.6-sol",
        "--max-depth=4",
        "--max-total-calls",
        "20",
        "-p",
        "Do the work.",
      ]),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      maxDepth: 4,
      maxTotalCalls: 20,
    });
  });

  it.each(["baml", "copilot-sdk"] as const)(
    "parses the %s visualization renderer",
    (visualizationRenderer) => {
      expect(
        parseRlmCliArgs(["--visualization-renderer", visualizationRenderer, "-p", "Do the work."]),
      ).toMatchObject({ visualizationRenderer });
    },
  );

  it.each([
    [["--prompt-file", "/tmp/prompt.txt"], "/tmp/prompt.txt"],
    [["--prompt-file=/tmp/prompt.txt"], "/tmp/prompt.txt"],
  ])("parses a prompt file path from %j", (promptFileArgs, expected) => {
    expect(parseRlmCliArgs(promptFileArgs)).toEqual({
      promptFile: expected,
      trellage: false,
      eagerWorktree: false,
      help: false,
    });
  });

  it("rejects combining -p/--prompt with --prompt-file", () => {
    expect(() =>
      parseRlmCliArgs(["-p", "Do the work.", "--prompt-file", "/tmp/prompt.txt"]),
    ).toThrow(/only one of -p\/--prompt or --prompt-file/u);
  });

  it("allows --resume with --prompt-file instead of -p/--prompt", () => {
    expect(
      parseRlmCliArgs([
        "--resume",
        "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
        "--prompt-file",
        "/tmp/prompt.txt",
      ]),
    ).toEqual({
      promptFile: "/tmp/prompt.txt",
      resume: "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
      trellage: false,
      eagerWorktree: false,
      help: false,
    });
  });

  it("rejects eager worktree provisioning without trellage, which would provision nothing", () => {
    expect(() => parseRlmCliArgs(["--eager-worktree", "-p", "Do the work."])).toThrow(
      /requires --trellage/u,
    );
  });

  it("rejects current-worktree reuse without trellage", () => {
    expect(() => parseRlmCliArgs(["--reuse-current-worktree", "-p", "Do the work."])).toThrow(
      /requires --trellage/u,
    );
  });

  it("parses the help flag without requiring telemetry or a Copilot session", () => {
    expect(parseRlmCliArgs(["--help"])).toEqual({
      trellage: false,
      eagerWorktree: false,
      help: true,
    });
  });

  it.each([
    [["-p"], "requires a non-empty prompt"],
    [["--prompt="], "requires a non-empty prompt"],
    [["--prompt-file"], "requires a non-empty path"],
    [["--prompt-file="], "requires a non-empty path"],
    [["--cwd"], "requires a non-empty path"],
    [["--cwd="], "requires a non-empty path"],
    [["--max-depth", "0"], "requires a positive integer"],
    [["--max-total-calls", "many"], "requires a positive integer"],
    [["--visualization-renderer"], 'requires "baml" or "copilot-sdk"'],
    [["--visualization-renderer", "browser"], 'requires "baml" or "copilot-sdk"'],
    [["--visualization-renderer", "baml", "--visualization-renderer", "copilot-sdk"], "only once"],
    [["-p", "one", "--prompt", "two"], "only once"],
    [["--resume", "f13c1665-bc2c-4d97-9c37-8f31d5c87d17"], "requires -p/--prompt"],
    [["--resume", "not-a-uuid", "--prompt", "Continue."], "requires a UUID"],
    [
      [
        "--resume",
        "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
        "--resume",
        "312ee252-f8ab-4d95-96e1-14fbad9102e0",
        "--prompt",
        "Continue.",
      ],
      "only once",
    ],
    [["--unknown"], "Unknown argument"],
  ])("rejects invalid arguments %j", (args, message) => {
    expect(() => parseRlmCliArgs(args)).toThrow(message);
  });

  it("collects repeated run brief flags in both spellings", () => {
    expect(
      parseRlmCliArgs([
        "--prompt",
        "Ship it.",
        "--acceptance",
        "Tests pass.",
        "--acceptance=Docs updated.",
        "--constraint",
        "Do not change the public API.",
        "--validation-command",
        "nub run test",
        "--validation-command=nub run typecheck",
      ]),
    ).toEqual({
      prompt: "Ship it.",
      acceptanceCriteria: ["Tests pass.", "Docs updated."],
      constraints: ["Do not change the public API."],
      validationCommands: ["nub run test", "nub run typecheck"],
      trellage: false,
      eagerWorktree: false,
      help: false,
    });
  });

  it("omits run brief fields that were never bound", () => {
    const options = parseRlmCliArgs(["--prompt", "Ship it.", "--acceptance", "Tests pass."]);

    expect(options.acceptanceCriteria).toEqual(["Tests pass."]);
    expect(options).not.toHaveProperty("constraints");
    expect(options).not.toHaveProperty("validationCommands");
  });

  it.each([
    [["--acceptance"], "requires a non-empty value"],
    [["--constraint="], "requires a non-empty value"],
    [["--validation-command"], "requires a non-empty value"],
  ])("rejects empty run brief values %j", (args, message) => {
    expect(() => parseRlmCliArgs(args)).toThrow(message);
  });
});
