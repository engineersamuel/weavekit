import { describe, expect, it } from "vitest";
import {
  buildCodexPlanInvocation,
  buildCopilotPlanInvocation,
  runPlanCommand,
} from "../../../src/eval/sourceToProjectVerification/commands.js";

describe("source-to-project baseline plan commands", () => {
  it("runs Copilot in non-interactive plan mode with only read tools available", () => {
    const invocation = buildCopilotPlanInvocation({
      workspaceDir: "/tmp/verification",
      prompt: "Plan the change.",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    expect(invocation.command).toBe("copilot");
    expect(invocation.cwd).toBe("/tmp/verification");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--plan",
        "--available-tools=view,rg,glob",
        "--allow-all-tools",
        "--deny-tool=write",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--no-ask-user",
        "--disallow-temp-dir",
        "--silent",
        "--no-color",
        "--stream",
        "off",
        "--model",
        "gpt-5.4",
        "--effort",
        "high",
        "-C",
        "/tmp/verification",
        "-p",
        "Plan the change.",
      ]),
    );
    expect(invocation.args).not.toContain("--allow-all");
  });

  it("runs Codex non-interactively with a read-only ephemeral sandbox", () => {
    const invocation = buildCodexPlanInvocation({
      workspaceDir: "/tmp/verification",
      prompt: "Plan the change.",
      outputPath: "/tmp/artifacts/codex-plan.md",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.cwd).toBe("/tmp/verification");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "-c",
        'model_reasoning_effort="high"',
        "-C",
        "/tmp/verification",
        "-o",
        "/tmp/artifacts/codex-plan.md",
        "-m",
        "gpt-5.3-codex",
        "Plan the change.",
      ]),
    );
    expect(invocation.args).not.toContain("--ignore-user-config");
    expect(invocation.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("closes child stdin so non-interactive plan commands can exit", async () => {
    const output = await runPlanCommand(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('done'));",
        ],
        cwd: process.cwd(),
      },
      { timeoutMs: 1_000 },
    );

    expect(output).toBe("done");
  });
});
