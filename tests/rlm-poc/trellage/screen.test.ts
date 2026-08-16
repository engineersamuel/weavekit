import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TrellageScreenKind,
  classifyScreen,
  extractQuestion,
  findApprovalOption,
  isLikelyQuestion,
  keysToChoose,
  parseMenuOptions,
} from "../../../src/rlm-poc/trellage/screen.js";

/** Claude Code's startup gate, which pre-selects the *declining* option. */
const BYPASS_PERMISSIONS = `
╭──────────────────────────────────────────────╮
│ WARNING: Bypass Permissions mode             │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. No, exit                                │
│   2. Yes, I accept                           │
╰──────────────────────────────────────────────╯
`;

const TOOL_PERMISSION = `
Bash command
  rm -rf build

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for rm commands
  3. No, and tell Claude what to do differently (esc)
`;

const PROSE_QUESTION = `
● I've reviewed the two candidate approaches.

  Which database should the new service use, Postgres or SQLite? I need to know
  before I can scaffold the migrations.

> │                                                                  │
`;

const COPILOT_STARTUP_SPLASH = `
Current   Sessions   Issues   Pull requests   Gists
  ╰─╯╰─╯  Copilot v1.0.79 uses AI.
  █ ▘▝ █  Check for mistakes.
   ▔▔▔▔
 ● Tip: /theme
   └ View or set color mode
 ~/.herdr/worktrees/weavekit/worktree-rlm [⎇ worktree/rlm*%] [#51]
Session: 0 AIC used
 ← open sidebar · autopilot · / commands · tab next tab
Claude Sonnet 5 · Medium
`;

const COPILOT_STARTUP_SPLASH_WITH_QUESTION_TIP = `
Current   Sessions   Issues   Pull requests   Gists
  ╰─╯╰─╯  Copilot v1.0.79 uses AI.
  █ ▘▝ █  Check for mistakes.
   ▔▔▔▔
 ● Tip: /app
   └ Prefer a visual workspace? Try out the GitHub Copilot desktop app
      https://github.com/features/ai/github-app
 ~/.herdr/worktrees/weavekit/worktree-rlm [⎇ worktree/rlm*%] [#51]
Session: 0 AIC used
 ← open sidebar · autopilot · / commands · tab next tab
Claude Sonnet 5
`;

describe("parseMenuOptions", () => {
  it("reads numbered options and the selection marker", () => {
    expect(parseMenuOptions(BYPASS_PERMISSIONS)).toEqual([
      { number: 1, label: "No, exit", selected: true },
      { number: 2, label: "Yes, I accept", selected: false },
    ]);
  });

  it("restarts on a fresh option list so earlier transcript text is discarded", () => {
    const options = parseMenuOptions(`
      Earlier output mentioned:
      1. some old list item
      2. another old item

      Do you want to proceed?
      1. Yes
      2. No
    `);

    expect(options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  it("ignores a numbered line that does not continue the run", () => {
    const options = parseMenuOptions("1. Yes\n5. Stray\n2. No");

    expect(options.map((option) => option.number)).toEqual([1, 2]);
  });
});

describe("classifyScreen", () => {
  it("classifies a numbered dialog as a menu", () => {
    expect(classifyScreen(TOOL_PERMISSION).kind).toBe(TrellageScreenKind.Menu);
  });

  it("classifies a question asked in prose as prose", () => {
    expect(classifyScreen(PROSE_QUESTION).kind).toBe(TrellageScreenKind.Prose);
  });
});

describe("findApprovalOption", () => {
  it("picks the affirmative option even when a declining option is pre-selected", () => {
    const options = parseMenuOptions(BYPASS_PERMISSIONS);

    expect(findApprovalOption(options)?.number).toBe(2);
  });

  it("prefers the plain affirmative over a broader always-allow variant", () => {
    const options = parseMenuOptions(TOOL_PERMISSION);

    expect(findApprovalOption(options)?.label).toBe("Yes");
  });

  it("declines to guess when no option is unambiguously affirmative", () => {
    const options = parseMenuOptions("1. Rebase onto main\n2. Merge main in\n3. Cancel");

    expect(findApprovalOption(options)).toBeUndefined();
  });

  it("never treats a negative option as approval", () => {
    const options = parseMenuOptions("1. No, and tell me why\n2. Cancel");

    expect(findApprovalOption(options)).toBeUndefined();
  });
});

describe("keysToChoose", () => {
  it("moves down from the selected option", () => {
    const options = parseMenuOptions(BYPASS_PERMISSIONS);

    expect(keysToChoose(options, options[1]!)).toEqual(["down", "enter"]);
  });

  it("moves up when the target is above the selection", () => {
    const options = parseMenuOptions(TOOL_PERMISSION).map((option, index) => ({
      ...option,
      selected: index === 2,
    }));

    expect(keysToChoose(options, options[0]!)).toEqual(["up", "up", "enter"]);
  });

  it("anchors at the top when nothing is marked as selected", () => {
    const options = parseMenuOptions("1. Yes\n2. No");

    expect(keysToChoose(options, options[1]!)).toEqual(["up", "up", "down", "enter"]);
  });
});

describe("extractQuestion", () => {
  it("keeps the question and drops box drawing and empty rows", () => {
    const question = extractQuestion(PROSE_QUESTION);

    expect(question).toContain("Which database should the new service use");
    expect(question).not.toContain("╭");
  });
});

describe("isLikelyQuestion", () => {
  it("accepts an actual prose question", () => {
    expect(isLikelyQuestion(extractQuestion(PROSE_QUESTION))).toBe(true);
  });

  it("rejects a stable Claude startup prompt echo", () => {
    expect(
      isLikelyQuestion(`
❯ Read the file .weavekit/rlm-trellage/run/call/task.md and carry out the task described in it, following its reporting instructions exactly.
⏵⏵ bypass permissions on (shift+tab to cycle)
Update available! Run: mise upgrade claude
● high · /effort
`),
    ).toBe(false);
  });

  it("rejects the Copilot startup splash that only shows tips and status", () => {
    expect(isLikelyQuestion(extractQuestion(COPILOT_STARTUP_SPLASH))).toBe(false);
  });

  it("rejects the Copilot startup splash even when a static tip contains a question mark", () => {
    expect(isLikelyQuestion(extractQuestion(COPILOT_STARTUP_SPLASH_WITH_QUESTION_TIP))).toBe(false);
  });
});

describe("Copilot folder-trust dialog", () => {
  const dialog = readFileSync(
    new URL("./fixtures/copilot-folder-trust-dialog.txt", import.meta.url),
    "utf8",
  );

  it("reads the recorded dialog as a menu whose affirmative option is already selected", () => {
    const screen = classifyScreen(dialog);

    expect(screen).toEqual({
      kind: TrellageScreenKind.Menu,
      options: [
        { number: 1, label: "Yes", selected: true },
        { number: 2, label: "Yes, and remember this folder for future sessions", selected: false },
        { number: 3, label: "No (Esc)", selected: false },
      ],
    });
  });

  it("approves the session-only option rather than persisting an ephemeral worktree path", () => {
    const screen = classifyScreen(dialog);
    if (screen.kind !== TrellageScreenKind.Menu) throw new Error("expected a menu");
    const approval = findApprovalOption(screen.options);

    expect(approval?.number).toBe(1);
    expect(keysToChoose(screen.options, approval!)).toEqual(["enter"]);
  });

  it("is still recognizable after the drive loop strips repaint whitespace", () => {
    const normalized = dialog
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+$/u, ""))
      .filter((line) => line.length > 0)
      .join("\n");

    expect(classifyScreen(normalized).kind).toBe(TrellageScreenKind.Menu);
    expect(isLikelyQuestion(extractQuestion(normalized))).toBe(true);
  });
});
