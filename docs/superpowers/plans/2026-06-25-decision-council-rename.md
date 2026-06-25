# Decision Council Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the active v0 workflow from Design Council/Council to Decision Council end to end, intentionally breaking old CLI/API/artifact compatibility.

**Architecture:** Keep the existing finite fan-out/fan-in workflow and rename the product seam around it. The public API becomes `runDecisionCouncil(input, options)`, implementation moves to `src/decision-council/*`, BAML contracts and generated client symbols use Decision Council names, and the CLI/artifacts/log events use decision-council terminology without legacy aliases.

**Tech Stack:** TypeScript, Vitest, Zod, BAML, GitHub Copilot SDK, Flue runtime, npm scripts.

## Global Constraints

- This is an intentional breaking rename; do not keep a `council` CLI alias.
- Do not keep old artifact filenames.
- Do not introduce a second workflow beside the old one.
- Do not change persona behavior, round scheduling, BAML validation policy, or stop policy.
- Do not broaden Weavekit into a general workflow framework beyond the current Decision Council surface.
- Preserve the `nextRoundBrief: null` schema boundary fix.
- Active source, tests, README, example, BAML prompt, generated client, and artifact assertions must not refer to `Design Council` except dated historical docs that are intentionally preserved.
- Public exports expose `DecisionCouncil*` names with no `Council*` compatibility aliases.
- After BAML changes, run `npm run baml-generate` and commit generated files.
- Existing unrelated local changes may be present in `examples/design-question.md`, `src/council/types.ts`, `tests/council/types.test.ts`, and `SPIKE_PLAN.md`; do not discard user work.

---

## File Structure

- Rename directory `src/council/` to `src/decision-council/`. The files keep the same responsibilities:
  - `types.ts`: Zod domain schemas and `createInitialRunState`.
  - `personas.ts`: default persona set and persona-set parsing.
  - `personaWorker.ts`: Copilot SDK persona session adapter.
  - `bamlAdapters.ts`: generated BAML client adapter seam.
  - `workflow.ts`: finite Decision Council loop.
  - `runner.ts`: public `runDecisionCouncil` wrapper and artifact/logger wiring.
  - `artifacts.ts`: Markdown/state/debug artifact writer.
  - `logger.ts`: structured and pretty progress logging.
  - `errors.ts`: run failure error.
- Rename test directory `tests/council/` to `tests/decision-council/`.
- Rename `baml_src/council.baml` to `baml_src/decision_council.baml`.
- Rename active example `examples/design-question.md` to `examples/decision-question.md`.
- Update `src/cli.ts`, `src/index.ts`, `package.json`, `README.md`, and generated files under `src/generated/baml_client/`.

---

### Task 1: Domain Types and Public API Rename

**Files:**
- Move: `src/council/` -> `src/decision-council/`
- Move: `tests/council/` -> `tests/decision-council/`
- Modify: `src/decision-council/types.ts`
- Modify: `src/decision-council/errors.ts`
- Modify: `src/index.ts`
- Test: `tests/decision-council/types.test.ts`

**Interfaces:**
- Consumes: Existing schemas and helper in `src/council/types.ts`.
- Produces:
  - `DecisionCouncilInputSchema`
  - `DecisionCouncilReportSchema`
  - `DecisionCouncilRunStateSchema`
  - `DecisionCouncilRoundSchema`
  - `DecisionCouncilInput`
  - `DecisionCouncilReport`
  - `DecisionCouncilRunState`
  - `DecisionCouncilRound`
  - `DecisionCouncilRunFailedError`
  - `createInitialRunState(input: z.input<typeof DecisionCouncilInputSchema>, personaSet: PersonaSet): DecisionCouncilRunState`

- [ ] **Step 1: Move implementation and tests with git**

```bash
git mv src/council src/decision-council
git mv tests/council tests/decision-council
```

Expected: the move is staged as renames, and imports are temporarily broken until later steps.

- [ ] **Step 2: Write the failing domain/API tests**

Edit `tests/decision-council/types.test.ts` so its imports and assertions use Decision Council names:

```ts
import { describe, expect, it } from "vitest";
import {
  DecisionCouncilInputSchema,
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionRoundAssessmentSchema,
  createInitialRunState,
} from "../../src/decision-council/types.js";
import { defaultPersonaSet } from "../../src/decision-council/personas.js";

describe("decision council domain types", () => {
  it("accepts a minimal decision council input", () => {
    const parsed = DecisionCouncilInputSchema.parse({
      prompt: "Which orchestration option should we use for this workflow?",
    });

    expect(parsed.prompt).toContain("orchestration option");
    expect(parsed.constraints).toEqual([]);
  });

  it("creates initial run state with max three rounds", () => {
    const state = createInitialRunState(
      { prompt: "Evaluate this decision." },
      defaultPersonaSet,
    );

    expect(state.maxRounds).toBe(3);
    expect(state.rounds).toEqual([]);
    expect(state.personas.map((persona) => persona.id)).toEqual([
      "socratic",
      "deep-module-dry",
      "pragmatic",
      "skeptic",
    ]);
  });

  it("requires decision-ready report fields", () => {
    const report = DecisionCouncilReportSchema.parse({
      recommendation: "Use the smallest reversible option.",
      rationale: ["It preserves learning speed while limiting lock-in."],
      strongestObjections: ["The reversible option may miss durability needs."],
      unresolvedQuestions: ["What persistence guarantees are required?"],
      confidence: 0.74,
      convergence: 0.8,
      nextExperiment: "Run one decision council on a real tradeoff.",
      finalReportMarkdown: "# Decision Council Report\n\nUse the smallest reversible option.",
      failedPersonas: [],
    });

    expect(report.confidence).toBeGreaterThan(0.7);
    expect(report.finalReportMarkdown).toContain("# Decision Council Report");
  });

  it("requires normalized persona critiques to include a compact overall summary", () => {
    const critique = DecisionPersonaCritiqueSchema.parse({
      personaId: "pragmatic",
      overallSummary: "Pragmatic persona recommends a minimal validation spike before choosing.",
      summary: "The decision should be validated with the smallest useful experiment.",
      claims: ["The smallest useful experiment is enough for v0."],
      risks: ["Premature framework adoption can obscure the core product risk."],
      questions: ["What measurable problem justifies the choice?"],
      recommendations: ["Run a focused spike before expanding the orchestration layer."],
    });

    expect(critique.overallSummary).toContain("minimal validation spike");
  });

  it("normalizes a null next round brief from BAML into an omitted brief", () => {
    const assessment = DecisionRoundAssessmentSchema.parse({
      roundNumber: 3,
      consensus: "Run a Mastra-first spike with fallback criteria.",
      disagreements: ["How long the spike should take."],
      confidence: 0.84,
      convergence: 0.78,
      shouldContinue: false,
      diminishingReturns: true,
      nextRoundBrief: null,
    });

    expect(assessment.nextRoundBrief).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the domain test to verify it fails**

Run:

```bash
npm test -- tests/decision-council/types.test.ts
```

Expected: FAIL with missing exports such as `DecisionCouncilInputSchema` or import errors from files still using `Council*` names.

- [ ] **Step 4: Rename domain schemas and error class**

Edit `src/decision-council/types.ts` to provide the renamed exports and remove old `Council*` type names:

```ts
export const DecisionCouncilInputSchema = z.object({
  prompt: z.string().min(1),
  context: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  personaSetName: z.string().min(1).optional(),
});

export type DecisionCouncilInput = z.infer<typeof DecisionCouncilInputSchema>;
```

Use these renamed schema definitions:

```ts
export const DecisionPersonaCritiqueSchema = z.object({
  personaId: z.string().min(1),
  overallSummary: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  recommendations: z.array(z.string().min(1)),
});
export type DecisionPersonaCritique = z.infer<typeof DecisionPersonaCritiqueSchema>;

export const DecisionPersonaFailureSchema = z.object({
  personaId: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type DecisionPersonaFailure = z.infer<typeof DecisionPersonaFailureSchema>;

export const DecisionRoundAssessmentSchema = z.object({
  roundNumber: z.number().int().positive(),
  consensus: z.string().min(1),
  disagreements: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  shouldContinue: z.boolean(),
  diminishingReturns: z.boolean(),
  nextRoundBrief: z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional()),
});
export type DecisionRoundAssessment = z.infer<typeof DecisionRoundAssessmentSchema>;

export const DecisionCouncilReportSchema = z.object({
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)),
  strongestObjections: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  nextExperiment: z.string().min(1),
  finalReportMarkdown: z.string().min(1),
  failedPersonas: z.array(DecisionPersonaFailureSchema),
});
export type DecisionCouncilReport = z.infer<typeof DecisionCouncilReportSchema>;

export const DecisionCouncilRoundSchema = z.object({
  brief: RoundBriefSchema,
  rawResults: z.array(RawPersonaResultSchema),
  critiques: z.array(DecisionPersonaCritiqueSchema),
  failures: z.array(DecisionPersonaFailureSchema),
  assessment: DecisionRoundAssessmentSchema,
});
export type DecisionCouncilRound = z.infer<typeof DecisionCouncilRoundSchema>;

export const DecisionCouncilRunStateSchema = z.object({
  input: DecisionCouncilInputSchema,
  personas: z.array(PersonaDefinitionSchema),
  maxRounds: z.number().int().positive(),
  rounds: z.array(DecisionCouncilRoundSchema),
  finalReport: DecisionCouncilReportSchema.optional(),
  stopReason: z.enum(["consensus", "diminishing-returns", "max-rounds"]).optional(),
});
export type DecisionCouncilRunState = z.infer<typeof DecisionCouncilRunStateSchema>;
```

Keep these generic names unchanged because they are implementation concepts, not product API names:

```ts
PersonaDefinitionSchema
PersonaSetSchema
RoundBriefSchema
RawPersonaResultSchema
PersonaDefinition
PersonaSet
RoundBrief
RawPersonaResult
```

Edit `src/decision-council/errors.ts`:

```ts
export class DecisionCouncilRunFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "DecisionCouncilRunFailedError";
    this.exitCode = exitCode;
  }
}
```

- [ ] **Step 5: Update `src/index.ts` public exports**

Replace the contents with:

```ts
export const version = "0.0.0";

export type {
  DecisionCouncilInput,
  DecisionCouncilReport,
  DecisionCouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./decision-council/types.js";
export { defaultPersonaSet, resolvePersonaSet } from "./decision-council/personas.js";
export { runDecisionCouncil, type RunDecisionCouncilOptions } from "./decision-council/runner.js";
export { createDecisionCouncilWorkflow, type DecisionCouncilWorkflowDeps } from "./decision-council/workflow.js";
```

- [ ] **Step 6: Update intra-module imports enough for type tests**

In files under `src/decision-council/`, replace import paths that still point to `./types.js` with renamed imported symbols. For example, `personas.ts` should start with:

```ts
import { PersonaSetSchema, type PersonaSet } from "./types.js";
```

No rename is needed there because `PersonaSet` remains generic.

- [ ] **Step 7: Run the domain test to verify it passes**

Run:

```bash
npm test -- tests/decision-council/types.test.ts
```

Expected: PASS for the domain type tests.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/decision-council tests/decision-council
git add -u src/council tests/council
git commit -m "refactor: rename council domain API to decision council"
```

---

### Task 2: CLI, Runner, Workflow, Artifacts, and Logger Rename

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/decision-council/runner.ts`
- Modify: `src/decision-council/workflow.ts`
- Modify: `src/decision-council/artifacts.ts`
- Modify: `src/decision-council/logger.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/decision-council/runner.test.ts`
- Modify: `tests/decision-council/artifacts.test.ts`
- Modify: `tests/decision-council/logger.test.ts`

**Interfaces:**
- Consumes:
  - `DecisionCouncilInputSchema`
  - `DecisionCouncilReport`
  - `DecisionCouncilRunState`
  - `DecisionCouncilRunFailedError`
- Produces:
  - `parseDecisionCouncilCliArgs(argv: string[]): DecisionCouncilCliArgs`
  - `readDecisionCouncilInputFile(inputPath: string): Promise<DecisionCouncilInput>`
  - `formatDecisionCouncilSuccessMessage(args: { recommendation: string; outputDir: string }): string`
  - `createDecisionCouncilLogger(format: LogFormat): DecisionCouncilLogger`
  - `runDecisionCouncil(input: z.input<typeof DecisionCouncilInputSchema>, options?: RunDecisionCouncilOptions): Promise<DecisionCouncilReport>`
  - `writeDecisionCouncilArtifacts(args): Promise<DecisionCouncilArtifacts>`
  - structured event names prefixed with `decision_council.`

- [ ] **Step 1: Write failing CLI tests**

Edit `tests/cli.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatDecisionCouncilSuccessMessage,
  parseDecisionCouncilCliArgs,
  readDecisionCouncilInputFile,
} from "../src/cli.js";

describe("CLI", () => {
  it("parses decision-council run arguments", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "question.md",
      "--output",
      "runs/question",
    ]);

    expect(parsed).toEqual({
      inputPath: "question.md",
      outputDir: "runs/question",
      logFormat: "pretty",
    });
  });

  it("rejects the removed council run command", () => {
    expect(() => parseDecisionCouncilCliArgs(["council", "run", "--input", "question.md"])).toThrow(
      "Usage: weavekit decision-council run --input <path> [--output <dir>]",
    );
  });

  it("parses JSON log format", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "question.md",
      "--log-format",
      "json",
    ]);

    expect(parsed).toEqual({
      inputPath: "question.md",
      outputDir: "runs/latest",
      logFormat: "json",
    });
  });

  it("reads Markdown input into DecisionCouncilInput", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-cli-"));
    const inputPath = join(dir, "question.md");

    try {
      await writeFile(inputPath, "# Question\n\nWhich option should we choose?", "utf8");
      const input = await readDecisionCouncilInputFile(inputPath);
      expect(input.prompt).toContain("Which option should we choose?");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formats final output with a Decision Council Markdown report link", () => {
    const message = formatDecisionCouncilSuccessMessage({
      recommendation: "Choose the smallest reversible option.",
      outputDir: "runs/example",
    });

    expect(message).toContain("Choose the smallest reversible option.");
    expect(message).toContain("Markdown report: runs/example/DecisionCouncilReport.md");
  });
});
```

- [ ] **Step 2: Write failing artifact tests**

In `tests/decision-council/artifacts.test.ts`, rename imports and assertions:

```ts
import { renderDecisionCouncilReportMarkdown, writeDecisionCouncilArtifacts } from "../../src/decision-council/artifacts.js";
import type { DecisionCouncilRunState } from "../../src/decision-council/types.js";
```

Change expected Markdown and filenames:

```ts
expect(markdown).toContain("# Decision Council Report");
expect(markdown).toContain("## Recommendation");
expect(markdown).toContain("Use Flue for v0.");
expect(markdown).toContain("## Strongest Objections");
expect(markdown).not.toContain("Raw transcript");
const artifacts = await writeDecisionCouncilArtifacts({ outputDir, state });
expect(artifacts.reportPath).toBe(join(outputDir, "DecisionCouncilReport.md"));
expect(artifacts.statePath).toBe(join(outputDir, "DecisionCouncilRunState.json"));
```

- [ ] **Step 3: Write failing logger and runner tests**

In `tests/decision-council/logger.test.ts`, use:

```ts
import {
  createConsoleDecisionCouncilLogger,
  createJsonDecisionCouncilLogger,
  createSilentDecisionCouncilLogger,
  formatDecisionCouncilEvent,
  type DecisionCouncilEvent,
} from "../../src/decision-council/logger.js";
```

Set event types to the new prefix:

```ts
const event: DecisionCouncilEvent = {
  type: "decision_council.persona.completed",
  timestamp: "2026-06-24T18:00:00.000Z",
  runId: "run-1",
  roundNumber: 1,
  personaId: "skeptic",
  durationMs: 1234,
};
```

In `tests/decision-council/runner.test.ts`, update imports and event assertions:

```ts
import { runDecisionCouncil } from "../../src/decision-council/runner.js";
import { createDecisionCouncilWorkflow } from "../../src/decision-council/workflow.js";
```

Expected event names:

```ts
expect(events).toContain("decision_council.run.started");
expect(events).toContain("decision_council.round.started");
expect(events).toContain("decision_council.persona.started");
expect(events).toContain("decision_council.persona.completed");
expect(events).toContain("decision_council.baml.started");
expect(events).toContain("decision_council.baml.completed");
expect(events).toContain("decision_council.round.completed");
expect(events).toContain("decision_council.run.completed");
```

Use `# Decision Council Report` in all final report fixtures.

- [ ] **Step 4: Run focused tests to verify failures**

Run:

```bash
npm test -- tests/cli.test.ts tests/decision-council/artifacts.test.ts tests/decision-council/logger.test.ts tests/decision-council/runner.test.ts
```

Expected: FAIL because implementation still exports old function/type names and old event/artifact names.

- [ ] **Step 5: Implement CLI rename**

Edit `src/cli.ts` imports and exported names:

```ts
import { runDecisionCouncil } from "./decision-council/runner.js";
import { DecisionCouncilRunFailedError } from "./decision-council/errors.js";
import {
  createConsoleDecisionCouncilLogger,
  createJsonDecisionCouncilLogger,
  createSilentDecisionCouncilLogger,
  type DecisionCouncilLogger,
} from "./decision-council/logger.js";
import type { DecisionCouncilInput } from "./decision-council/types.js";
```

Use these names:

```ts
export type DecisionCouncilCliArgs = {
  inputPath: string;
  outputDir: string;
  logFormat: LogFormat;
};

const usage = "Usage: weavekit decision-council run --input <path> [--output <dir>]";

export function parseDecisionCouncilCliArgs(argv: string[]): DecisionCouncilCliArgs {
  if (argv[0] !== "decision-council" || argv[1] !== "run") {
    throw new Error(usage);
  }

  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("Missing required --input <path> argument.");
  }

  const outputIndex = argv.indexOf("--output");
  const logFormatIndex = argv.indexOf("--log-format");
  const logFormat = logFormatIndex === -1 ? "pretty" : argv[logFormatIndex + 1];

  if (logFormat !== "pretty" && logFormat !== "json" && logFormat !== "silent") {
    throw new Error("Invalid --log-format value. Expected pretty, json, or silent.");
  }

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
    logFormat,
  };
}

export async function readDecisionCouncilInputFile(inputPath: string): Promise<DecisionCouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt, context: [], constraints: [] };
}

export function formatDecisionCouncilSuccessMessage(args: { recommendation: string; outputDir: string }): string {
  return [
    args.recommendation,
    `Markdown report: ${join(args.outputDir, "DecisionCouncilReport.md")}`,
    `Artifacts written to ${args.outputDir}`,
    "",
  ].join("\n");
}
```

Update `main()` to call `parseDecisionCouncilCliArgs`, `readDecisionCouncilInputFile`, `runDecisionCouncil`, and `formatDecisionCouncilSuccessMessage`. In the catch handler, check `error instanceof DecisionCouncilRunFailedError`.

- [ ] **Step 6: Implement runner/workflow rename**

In `src/decision-council/runner.ts`, rename imports, types, and function:

```ts
export type RunDecisionCouncilOptions = {
  personaSet?: PersonaSet;
  outputDir?: string;
  inputPath?: string;
  logger?: DecisionCouncilLogger;
  deps?: Partial<DecisionCouncilWorkflowDeps> & {
    writeArtifacts?: boolean;
  };
};

export async function runDecisionCouncil(
  input: z.input<typeof DecisionCouncilInputSchema>,
  options: RunDecisionCouncilOptions = {},
): Promise<DecisionCouncilReport> {
  const runId = `decision-council-${Date.now().toString(36)}`;
  const startedAt = performance.now();
  const runId = `decision-council-${Date.now().toString(36)}`;
  const parsedInput = DecisionCouncilInputSchema.parse(input);
  const personaSet = resolvePersonaSet(options.personaSet);
  const bamlAdapters = new GeneratedBamlAdapters();
  const deps: DecisionCouncilWorkflowDeps = {
    personaWorker: options.deps?.personaWorker ?? new CopilotPersonaWorker(),
    normalizer: options.deps?.normalizer ?? bamlAdapters,
    judge: options.deps?.judge ?? bamlAdapters,
    logger: options.logger,
    runId,
  };

  options.logger?.event({
    type: "decision_council.run.started",
    timestamp: timestamp(),
    runId,
    inputPath: options.inputPath,
    outputDir: options.outputDir,
    personaCount: personaSet.personas.length,
    maxRounds: 3,
  });

  try {
    const initialState = createInitialRunState(parsedInput, personaSet);
    const finalState = await runDecisionCouncilLoop(initialState, deps);

    if (!finalState.finalReport) {
      throw new DecisionCouncilRunFailedError("Decision Council workflow completed without a final report.");
    }

    if (options.deps?.writeArtifacts !== false) {
      const artifacts = await writeDecisionCouncilArtifacts({
        outputDir: options.outputDir ?? "runs/latest",
        state: finalState,
      });
      options.logger?.event({
        type: "decision_council.artifacts.written",
        timestamp: timestamp(),
        runId,
        reportPath: artifacts.reportPath,
        statePath: artifacts.statePath,
        debugTranscriptCount: artifacts.debugTranscriptPaths.length,
      });
    }

    options.logger?.event({
      type: "decision_council.run.completed",
      timestamp: timestamp(),
      runId,
      stopReason: finalState.stopReason,
      durationMs: performance.now() - startedAt,
    });

    return finalState.finalReport;
  } catch (error) {
    options.logger?.event({
      type: "decision_council.run.failed",
      timestamp: timestamp(),
      runId,
      durationMs: performance.now() - startedAt,
      error: errorMessage(error),
    });
    throw error;
  }
}
```

Use `DecisionCouncilRunFailedError` and `writeDecisionCouncilArtifacts`. Update all emitted event types to `decision_council.*`.

In `src/decision-council/workflow.ts`, rename:

```ts
export type DecisionCouncilWorkflowDeps = {
  personaWorker: PersonaWorker;
  normalizer: CritiqueNormalizer;
  judge: JudgeReducer;
  logger?: DecisionCouncilLogger;
  runId?: string;
};

export async function runDecisionCouncilRound(
  state: DecisionCouncilRunState,
  deps: DecisionCouncilWorkflowDeps,
): Promise<DecisionCouncilRunState>;

export async function runDecisionCouncilLoop(
  initialState: DecisionCouncilRunState,
  deps: DecisionCouncilWorkflowDeps,
): Promise<DecisionCouncilRunState>;

export function createDecisionCouncilWorkflow(deps: DecisionCouncilWorkflowDeps): ReturnType<typeof defineWorkflow>;
```

Update the Flue agent instructions to:

```ts
"You host finite Decision Council workflow runs. Application code controls the decision loop and typed outputs."
```

Keep stop messages semantically equivalent but use Decision Council wording:

```ts
throw new DecisionCouncilRunFailedError("Decision Council requires at least two successful personas.");
throw new DecisionCouncilRunFailedError("Decision Council requires at least two normalized critiques.");
```

- [ ] **Step 7: Implement artifact rename**

In `src/decision-council/artifacts.ts`, rename the public types/functions:

```ts
export type DecisionCouncilArtifacts = {
  reportPath: string;
  statePath: string;
  debugTranscriptPaths: string[];
};

export function renderDecisionCouncilReportMarkdown(report: DecisionCouncilReport): string {
  if (report.finalReportMarkdown.trim().length > 0) {
    return report.finalReportMarkdown.endsWith("\n") ? report.finalReportMarkdown : `${report.finalReportMarkdown}\n`;
  }

  return [
    "# Decision Council Report",
    "",
    "## Recommendation",
    "",
    report.recommendation,
    "",
    "## Rationale",
    "",
    renderList(report.rationale).trimEnd(),
    "",
    "## Strongest Objections",
    "",
    renderList(report.strongestObjections).trimEnd(),
    "",
    "## Unresolved Questions",
    "",
    renderList(report.unresolvedQuestions).trimEnd(),
    "",
    "## Confidence and Convergence",
    "",
    `- Confidence: ${report.confidence.toFixed(2)}`,
    `- Convergence: ${report.convergence.toFixed(2)}`,
    "",
    "## Next Experiment",
    "",
    report.nextExperiment,
    "",
    "## Failed Personas",
    "",
    renderFailures(report.failedPersonas).trimEnd(),
    "",
  ].join("\n");
}

export async function writeDecisionCouncilArtifacts(args: {
  outputDir: string;
  state: DecisionCouncilRunState;
}): Promise<DecisionCouncilArtifacts> {
  const { outputDir, state } = args;

  if (!state.finalReport) {
    throw new Error("Cannot write decision council artifacts without a final report.");
  }

  await mkdir(outputDir, { recursive: true });
  const debugDir = join(outputDir, "debug");
  await mkdir(debugDir, { recursive: true });

  const reportPath = join(outputDir, "DecisionCouncilReport.md");
  const statePath = join(outputDir, "DecisionCouncilRunState.json");

  await writeFile(reportPath, renderDecisionCouncilReportMarkdown(state.finalReport), "utf8");
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const debugTranscriptPaths: string[] = [];
  for (const round of state.rounds) {
    for (let i = 0; i < round.rawResults.length; i++) {
      const result = round.rawResults[i]!;
      const transcriptPath = join(debugDir, `round-${round.brief.roundNumber}-${result.personaId}-${i}.txt`);
      await writeFile(transcriptPath, result.transcript.join("\n") + "\n", "utf8");
      debugTranscriptPaths.push(transcriptPath);
    }
  }

  return { reportPath, statePath, debugTranscriptPaths };
}
```

Use this error text:

```ts
throw new Error("Cannot write decision council artifacts without a final report.");
```

- [ ] **Step 8: Implement logger rename**

In `src/decision-council/logger.ts`, rename exported symbols:

```ts
export type DecisionCouncilEvent =
  | {
      type: "decision_council.run.started";
      timestamp: string;
      runId: string;
      inputPath?: string;
      outputDir?: string;
      personaCount: number;
      maxRounds: number;
    }
  | {
      type: "decision_council.round.started";
      timestamp: string;
      runId: string;
      roundNumber: number;
      focus: string;
      focusSource: "initial" | "judge";
      previousRoundNumber?: number;
    }
  | {
      type: "decision_council.persona.started" | "decision_council.persona.completed" | "decision_council.persona.failed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      personaId: string;
      durationMs?: number;
      error?: string;
    }
  | {
      type: "decision_council.baml.started" | "decision_council.baml.completed" | "decision_council.baml.failed";
      timestamp: string;
      runId: string;
      roundNumber?: number;
      operation: "normalize" | "assess" | "report";
      personaId?: string;
      durationMs?: number;
      summary?: string;
      error?: string;
    }
  | {
      type: "decision_council.round.completed";
      timestamp: string;
      runId: string;
      roundNumber: number;
      successfulPersonas: number;
      failedPersonas: number;
      confidence: number;
      convergence: number;
      shouldContinue: boolean;
      durationMs: number;
    }
  | {
      type: "decision_council.artifacts.written";
      timestamp: string;
      runId: string;
      reportPath: string;
      statePath: string;
      debugTranscriptCount: number;
    }
  | {
      type: "decision_council.run.completed" | "decision_council.run.failed";
      timestamp: string;
      runId: string;
      stopReason?: string;
      durationMs: number;
      error?: string;
    };

export type DecisionCouncilLogger = {
  event(event: DecisionCouncilEvent): void;
};
export function formatDecisionCouncilEvent(event: DecisionCouncilEvent, options: FormatOptions = {}): string;
export function createConsoleDecisionCouncilLogger(options?: LoggerOptions & FormatOptions): DecisionCouncilLogger;
export function createJsonDecisionCouncilLogger(options?: LoggerOptions): DecisionCouncilLogger;
export function createSilentDecisionCouncilLogger(options?: LoggerOptions): DecisionCouncilLogger;
```

Change every union event type from `council.*` to `decision_council.*`. Update label stripping:

```ts
function label(event: DecisionCouncilEvent): string {
  return event.type.replace(/^decision_council\./, "").replaceAll(".", " ");
}
```

Update child-line copy:

```ts
return "Initial decision brief; all personas respond independently, then the Judge assesses the round 1 set together.";
```

- [ ] **Step 9: Run focused tests to verify pass**

Run:

```bash
npm test -- tests/cli.test.ts tests/decision-council/artifacts.test.ts tests/decision-council/logger.test.ts tests/decision-council/runner.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/cli.ts src/decision-council tests/decision-council tests/cli.test.ts
git commit -m "refactor: rename decision council runtime surfaces"
```

---

### Task 3: BAML Contract and Generated Client Rename

**Files:**
- Move: `baml_src/council.baml` -> `baml_src/decision_council.baml`
- Modify: `src/decision-council/bamlAdapters.ts`
- Modify: `tests/decision-council/bamlAdapters.test.ts`
- Modify: `tests/decision-council/bamlProviders.test.ts`
- Modify: generated files under `src/generated/baml_client/`

**Interfaces:**
- Consumes: `DecisionPersonaCritiqueSchema`, `DecisionRoundAssessmentSchema`, `DecisionCouncilReportSchema`.
- Produces:
  - `GeneratedBamlAdapters.normalizeCritique(raw): Promise<DecisionPersonaCritique>`
  - `GeneratedBamlAdapters.assessRound(args): Promise<DecisionRoundAssessment>`
  - `GeneratedBamlAdapters.createFinalReport(args): Promise<DecisionCouncilReport>`
  - Generated BAML functions:
    - `b.NormalizeDecisionPersonaCritique`
    - `b.AssessDecisionCouncilRound`
    - `b.CreateDecisionCouncilReport`

- [ ] **Step 1: Write failing BAML provider test**

Edit `tests/decision-council/bamlProviders.test.ts`:

```ts
const decisionCouncil = await readFile("baml_src/decision_council.baml", "utf8");
const baml = await readFile("baml_src/clients.baml", "utf8");

expect(baml).toContain("base_url env.COPILOT_PROXY_BASE_URL");
expect(baml).toContain("api_key env.COPILOT_PROXY_API_KEY");
expect(baml).toContain('client<llm> DefaultClient');
expect(baml).toContain('model env.BAML_MODEL');
expect(decisionCouncil).not.toMatch(/^client<llm>/m);
expect(decisionCouncil).toContain("class DecisionPersonaCritique");
expect(decisionCouncil).toContain("class DecisionCouncilReport");
expect(decisionCouncil).toContain("function NormalizeDecisionPersonaCritique");
expect(decisionCouncil).toContain("function AssessDecisionCouncilRound");
expect(decisionCouncil).toContain("function CreateDecisionCouncilReport");
expect(decisionCouncil).toContain("Decision Council");
expect(decisionCouncil).not.toContain("Design Council");
```

- [ ] **Step 2: Write failing BAML adapter seam test**

Edit `tests/decision-council/bamlAdapters.test.ts` imports and fixtures:

```ts
import type { CritiqueNormalizer, JudgeReducer } from "../../src/decision-council/bamlAdapters.js";
```

Use `# Decision Council Report`:

```ts
finalReportMarkdown: "# Decision Council Report\n\nShip v0.",
```

- [ ] **Step 3: Run BAML tests to verify failures**

Run:

```bash
npm test -- tests/decision-council/bamlProviders.test.ts tests/decision-council/bamlAdapters.test.ts
```

Expected: FAIL because `baml_src/decision_council.baml` and generated BAML function names do not exist yet.

- [ ] **Step 4: Rename and edit the BAML source**

Run:

```bash
git mv baml_src/council.baml baml_src/decision_council.baml
```

Edit `baml_src/decision_council.baml` so the classes and functions are:

```baml
class RawPersonaResult {
  personaId string
  text string
}

class DecisionPersonaCritique {
  personaId string
  overallSummary string
  summary string
  claims string[]
  risks string[]
  questions string[]
  recommendations string[]
}

class DecisionPersonaFailure {
  personaId string
  message string
  retryable bool
}

class DecisionRoundAssessment {
  roundNumber int
  consensus string
  disagreements string[]
  confidence float
  convergence float
  shouldContinue bool
  diminishingReturns bool
  nextRoundBrief string?
}

class DecisionCouncilReport {
  recommendation string
  rationale string[]
  strongestObjections string[]
  unresolvedQuestions string[]
  confidence float
  convergence float
  nextExperiment string
  finalReportMarkdown string
  failedPersonas DecisionPersonaFailure[]
}
```

Use renamed function signatures:

```baml
function NormalizeDecisionPersonaCritique(raw: RawPersonaResult) -> DecisionPersonaCritique
function AssessDecisionCouncilRound(roundNumber: int, critiques: DecisionPersonaCritique[], failures: DecisionPersonaFailure[]) -> DecisionRoundAssessment
function CreateDecisionCouncilReport(critiques: DecisionPersonaCritique[], assessments: DecisionRoundAssessment[], failures: DecisionPersonaFailure[]) -> DecisionCouncilReport
```

Update prompt copy from design-specific wording to decision wording:

```text
You are the Judge reducer for a Decision Council. You are not a debating persona.
Create a decision-ready Decision Council report.
with a level-1 heading named Decision Council Report and including links/sections that make the
final artifact useful when written to DecisionCouncilReport.md.
```

- [ ] **Step 5: Update generated adapter calls**

Edit `src/decision-council/bamlAdapters.ts` to import renamed domain schemas and call generated BAML functions:

```ts
import {
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionRoundAssessmentSchema,
  type DecisionCouncilReport,
  type DecisionPersonaCritique,
  type DecisionPersonaFailure,
  type DecisionRoundAssessment,
  type RawPersonaResult,
} from "./types.js";
```

Update interface signatures and implementation:

```ts
export type CritiqueNormalizer = {
  normalizeCritique(raw: RawPersonaResult): Promise<DecisionPersonaCritique>;
};

export type JudgeReducer = {
  assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment>;
  createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport>;
};

export class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer {
  async normalizeCritique(raw: RawPersonaResult): Promise<DecisionPersonaCritique> {
    const result = await b.NormalizeDecisionPersonaCritique({
      personaId: raw.personaId,
      text: raw.text,
    });
    return DecisionPersonaCritiqueSchema.parse(result);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment> {
    const result = await b.AssessDecisionCouncilRound(args.roundNumber, args.critiques, args.failures);
    return DecisionRoundAssessmentSchema.parse(result);
  }

  async createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport> {
    const result = await b.CreateDecisionCouncilReport(args.critiques, args.assessments, args.failures);
    return DecisionCouncilReportSchema.parse(result);
  }
}
```

- [ ] **Step 6: Regenerate BAML client**

Run:

```bash
npm run baml-generate
```

Expected: generated files under `src/generated/baml_client/` update successfully and include `decision_council.baml` in the inline BAML bundle.

- [ ] **Step 7: Run BAML tests to verify pass**

Run:

```bash
npm test -- tests/decision-council/bamlProviders.test.ts tests/decision-council/bamlAdapters.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add baml_src src/generated src/decision-council/bamlAdapters.ts tests/decision-council/bamlAdapters.test.ts tests/decision-council/bamlProviders.test.ts
git add -u baml_src/council.baml
git commit -m "refactor: rename baml contracts for decision council"
```

---

### Task 4: Package Script, README, Example, and Active Text Cleanup

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Move: `examples/design-question.md` -> `examples/decision-question.md`
- Modify: `ideas/observability.md`
- Modify: active tests under `tests/decision-council/`

**Interfaces:**
- Consumes: `decision-council` CLI command from Task 2.
- Produces:
  - npm script: `"decision-council": "tsx src/cli.ts"`
  - active example path: `examples/decision-question.md`
  - README commands using `npm run decision-council -- decision-council run --input examples/decision-question.md --output runs/example` and `nub run decision-council decision-council run --input examples/decision-question.md --output runs/example`

- [ ] **Step 1: Write a failing cleanup check**

Run:

```bash
rg -n "Design Council|design council|CouncilReport|CouncilRunState|council run|npm run council|run\\.council|(^|[^_[:alnum:]])council\\." README.md package.json examples src tests baml_src ideas
```

Expected: matches in active files. Dated docs under `docs/superpowers/specs/2026-06-24-*` and `docs/superpowers/plans/2026-06-24-*` are intentionally excluded from this command.

- [ ] **Step 2: Rename package script**

Edit `package.json` scripts:

```json
"scripts": {
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "baml-generate": "baml-cli generate",
  "build": "npm run baml-generate && tsc -p tsconfig.json",
  "decision-council": "tsx src/cli.ts"
}
```

- [ ] **Step 3: Rename and rewrite the active example**

Run:

```bash
git mv examples/design-question.md examples/decision-question.md
```

Edit `examples/decision-question.md` to ask a generic decision question. Preserve any useful user edits from the original file while removing Design Council branding. A suitable content shape is:

```md
# Decision Question

Compare whether WeaveKit should use Mastra, LangGraph, or a minimal custom subprocess orchestrator for the v0 workflow and agent harness layer.

Help me make a decision by surfacing the strongest tradeoffs, risks, assumptions, and the smallest experiment that would reduce uncertainty.
```

- [ ] **Step 4: Update README usage and observability copy**

Edit `README.md` top section:

```md
The v0 workflow is a Decision Council. It runs four debating personas, normalizes their critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `DecisionCouncilReport.md`
- `DecisionCouncilRunState.json`
- raw transcript debug files
```

Rename the run section:

```md
## Run the Decision Council

```bash
npm run decision-council -- decision-council run --input examples/decision-question.md --output runs/example
```

With nub:

```bash
nub run decision-council decision-council run --input examples/decision-question.md --output runs/example
```
```

Update log commands:

```bash
nub run decision-council decision-council run --input examples/decision-question.md --output runs/example --log-format pretty
nub run decision-council decision-council run --input examples/decision-question.md --output runs/example --log-format json
nub run decision-council decision-council run --input examples/decision-question.md --output runs/example --log-format silent
```

Update event docs:

```md
`json` emits newline-delimited structured events such as `decision_council.run.started`, `decision_council.persona.completed`, and `decision_council.baml.completed`.
```

Update recommended span names:

```md
- `run.decision_council`
- `run.decision_council.round`
- `run.decision_council.persona`
- `run.decision_council.baml`
- `write.decision_council.artifacts`
```

- [ ] **Step 5: Update active observability note**

Edit `ideas/observability.md` to use `Decision Council`, `decision_council.*`, and `DecisionCouncilReport.md` where it discusses the active workflow. Do not rewrite unrelated ideas.

- [ ] **Step 6: Run cleanup check to verify pass**

Run:

```bash
rg -n "Design Council|design council|CouncilReport|CouncilRunState|council run|npm run council|run\\.council|(^|[^_[:alnum:]])council\\." README.md package.json examples src tests baml_src ideas
```

Expected: no matches.

- [ ] **Step 7: Run docs-adjacent tests**

Run:

```bash
npm test -- tests/cli.test.ts tests/decision-council/logger.test.ts tests/decision-council/artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json README.md examples ideas tests src baml_src
git add -u examples/design-question.md
git commit -m "docs: update usage for decision council"
```

---

### Task 5: Whole-Repository Verification and Final Rename Guard

**Files:**
- Modify only files needed to fix failures found by verification.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: a repository where tests, typecheck, build, BAML generation, and active rename scans pass.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS for all Vitest tests.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS. This also runs `npm run baml-generate`.

- [ ] **Step 4: Verify generated client is committed and stable**

Run:

```bash
git --no-pager diff -- src/generated/baml_client
npm run baml-generate
git --no-pager diff -- src/generated/baml_client
```

Expected: no diff after the second `npm run baml-generate`.

- [ ] **Step 5: Run active rename guard**

Run:

```bash
rg -n "Design Council|design council|CouncilReport|CouncilRunState|council run|npm run council|run\\.council|(^|[^_[:alnum:]])council\\." README.md package.json examples src tests baml_src ideas
```

Expected: no matches.

- [ ] **Step 6: Verify no old public exports remain**

Run:

```bash
rg -n "runCouncil|createCouncilWorkflow|CouncilInput|CouncilReport|CouncilRunState|CouncilRunFailedError|CouncilWorkflowDeps" src tests
```

Expected: no matches.

- [ ] **Step 7: Verify old CLI command is rejected**

Run:

```bash
npm run decision-council -- council run --input examples/decision-question.md --output runs/example
```

Expected: non-zero exit and stderr contains:

```text
Usage: weavekit decision-council run --input <path> [--output <dir>]
```

- [ ] **Step 8: Verify new CLI usage reaches runtime configuration**

Run without proxy env:

```bash
BAML_LOG=warn npm run decision-council -- decision-council run --input examples/decision-question.md --output runs/rename-smoke
```

Expected: the command starts the Decision Council path and fails only if local Copilot/BAML proxy configuration is missing. The error must not be a usage error, missing module error, old artifact path error, or old command-name error.

- [ ] **Step 9: Review worktree for unrelated files**

Run:

```bash
git --no-pager status --short
```

Expected: only files intentionally changed by this rename are staged or modified. If unrelated user changes remain, leave them unstaged.

- [ ] **Step 10: Commit verification fixes if any were needed**

If Steps 1-8 required code or docs fixes, commit them:

```bash
git add src tests baml_src README.md package.json examples ideas
git commit -m "fix: complete decision council rename"
```

If no fixes were needed, do not create an empty commit.
