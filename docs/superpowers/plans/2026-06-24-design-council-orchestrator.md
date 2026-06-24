# Design Council Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v0 Weavekit Design Council: a TypeScript CLI/library that runs a bounded multi-persona Copilot SDK council and writes decision-ready Markdown plus typed JSON state.

**Architecture:** The public seam is `runCouncil(input, { personaSet? }) => CouncilReport`. Internally, Flue provides the finite workflow and agent harness layer, Weavekit owns the explicit bounded council loop, persona workers call GitHub Copilot SDK sessions, BAML normalizes persona/Judge outputs at fan-in decision points, and an artifact store writes Markdown, JSON, and debug transcripts.

**Tech Stack:** TypeScript, Node.js 22+, Flue runtime/workflows, GitHub Copilot SDK, BAML TypeScript client, Zod, Valibot, Vitest, tsx.

## Global Constraints

- Use TypeScript for fastest iteration across workflow tooling, Copilot SDK integration, BAML, and CLI/report output.
- Use Flue as the finite workflow and agent harness layer for OSS-friendly workflows, tools, subagents, sessions, and future connector/adaptor growth.
- Use GitHub Copilot SDK sessions as persona workers from the start.
- Use BAML at selected decision points, not every LLM boundary.
- Keep the external module deep: callers use `runCouncil(input, { personaSet? }) => CouncilReport`.
- Allow one v0 escape hatch: persona set configuration.
- Produce decision-ready output, not agent theater.
- Do not add a web UI, cloud durability, Azure architecture workflow, product research workflow, Microsoft Agent Framework, Rust runner, or LangGraph implementation in v0.
- Default stop policy is max 3 rounds, explicit Judge consensus, or BAML-assessed diminishing returns.
- Raw Copilot transcripts are debug artifacts, not the primary state contract.
- No failure should be silently converted into success-shaped output.

---

## File Structure

- `package.json` — npm scripts and dependencies.
- `tsconfig.json` — strict TypeScript project config.
- `vitest.config.ts` — Vitest config.
- `.gitignore` — ignores dependencies, build output, generated run artifacts, and local env files.
- `src/index.ts` — public library exports.
- `src/cli.ts` — `weavekit council run` CLI entrypoint.
- `src/council/types.ts` — Zod schemas and TypeScript types for the public and internal state contracts.
- `src/council/personas.ts` — default persona set and persona validation.
- `src/council/personaWorker.ts` — `PersonaWorker` interface plus Copilot SDK adapter.
- `src/council/bamlAdapters.ts` — BAML adapter interfaces plus generated-client implementation.
- `src/council/artifacts.ts` — Markdown/JSON/debug artifact writing.
- `src/council/workflow.ts` — Flue workflow definition plus explicit council loop execution.
- `src/council/runner.ts` — public `runCouncil` module.
- `src/council/errors.ts` — explicit error classes and exit-code mapping.
- `baml_src/council.baml` — BAML classes and LLM functions for critique normalization, round assessment, and final report synthesis.
- `tests/council/*.test.ts` — unit/integration tests with fake persona and BAML adapters.
- `examples/design-question.md` — sample input for manual v0 verification.

---

### Task 1: Project Scaffold and Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Test: `tests/scaffold.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: npm scripts `test`, `typecheck`, `build`, `baml-generate`, `council`; public package entry `src/index.ts`.

- [ ] **Step 1: Write the failing scaffold smoke test**

Create `tests/scaffold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { version } from "../src/index";

describe("weavekit scaffold", () => {
  it("exports a version string", () => {
    expect(version).toBe("0.0.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/scaffold.test.ts
```

Expected: FAIL because `package.json`, Vitest, and `src/index.ts` do not exist yet.

- [ ] **Step 3: Create project package and tooling files**

Create `package.json`:

```json
{
  "name": "weavekit",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "bin": {
    "weavekit": "./dist/cli.js"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "baml-generate": "baml-cli generate",
    "build": "npm run baml-generate && tsc -p tsconfig.json",
    "council": "tsx src/cli.ts"
  },
  "dependencies": {
    "@boundaryml/baml": "^0.220.0",
    "@github/copilot-sdk": "^0.1.0",
    "@flue/runtime": "^1.0.0-beta.5",
    "valibot": "^1.0.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
runs/
.superpowers/
```

Create `src/index.ts`:

```ts
export const version = "0.0.0";
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and dependencies install successfully.

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- tests/scaffold.test.ts
```

Expected: PASS with 1 test.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/index.ts tests/scaffold.test.ts
git commit -m "chore: scaffold weavekit typescript project"
```

---

### Task 2: Domain Types and Default Persona Set

**Files:**
- Create: `src/council/types.ts`
- Create: `src/council/personas.ts`
- Modify: `src/index.ts`
- Test: `tests/council/types.test.ts`
- Test: `tests/council/personas.test.ts`

**Interfaces:**
- Consumes: Zod from Task 1.
- Produces:
  - `CouncilInputSchema`, `CouncilReportSchema`, `CouncilRunStateSchema`
  - `type CouncilInput`, `CouncilReport`, `CouncilRunState`, `PersonaDefinition`, `PersonaSet`
  - `defaultPersonaSet: PersonaSet`
  - `resolvePersonaSet(personaSet?: PersonaSet): PersonaSet`

- [ ] **Step 1: Write failing domain type tests**

Create `tests/council/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CouncilInputSchema,
  CouncilReportSchema,
  createInitialRunState,
} from "../../src/council/types";
import { defaultPersonaSet } from "../../src/council/personas";

describe("council domain types", () => {
  it("accepts a minimal council input", () => {
    const parsed = CouncilInputSchema.parse({
      prompt: "Should we use Flue for this workflow?",
    });

    expect(parsed.prompt).toContain("Flue");
    expect(parsed.constraints).toEqual([]);
  });

  it("creates initial run state with max three rounds", () => {
    const state = createInitialRunState(
      { prompt: "Evaluate this architecture." },
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
    const report = CouncilReportSchema.parse({
      recommendation: "Use Flue for v0.",
      rationale: ["It matches the workflow-first shape."],
      strongestObjections: ["Flue API churn is possible."],
      unresolvedQuestions: ["How stable is the Copilot SDK package?"],
      confidence: 0.74,
      convergence: 0.8,
      nextExperiment: "Build one council run against a real design question.",
      failedPersonas: [],
    });

    expect(report.confidence).toBeGreaterThan(0.7);
  });
});
```

Create `tests/council/personas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultPersonaSet, resolvePersonaSet } from "../../src/council/personas";

describe("persona sets", () => {
  it("ships the approved default debating personas", () => {
    expect(defaultPersonaSet.name).toBe("default");
    expect(defaultPersonaSet.personas.map((persona) => persona.name)).toEqual([
      "Socratic Questioner",
      "Deep Module/DRY Architect",
      "Pragmatic Builder",
      "Skeptic",
    ]);
  });

  it("copies a supplied persona set so callers cannot mutate defaults", () => {
    const resolved = resolvePersonaSet(defaultPersonaSet);
    resolved.personas[0]!.name = "Changed";

    expect(defaultPersonaSet.personas[0]!.name).toBe("Socratic Questioner");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/council/types.test.ts tests/council/personas.test.ts
```

Expected: FAIL because `src/council/types.ts` and `src/council/personas.ts` do not exist.

- [ ] **Step 3: Add domain types**

Create `src/council/types.ts`:

```ts
import { z } from "zod";

export const PersonaDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
});

export type PersonaDefinition = z.infer<typeof PersonaDefinitionSchema>;

export const PersonaSetSchema = z.object({
  name: z.string().min(1),
  personas: z.array(PersonaDefinitionSchema).min(2),
});

export type PersonaSet = z.infer<typeof PersonaSetSchema>;

export const CouncilInputSchema = z.object({
  prompt: z.string().min(1),
  context: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  personaSetName: z.string().min(1).optional(),
});

export type CouncilInput = z.infer<typeof CouncilInputSchema>;

export const RoundBriefSchema = z.object({
  roundNumber: z.number().int().positive(),
  prompt: z.string().min(1),
  focus: z.string().min(1),
});

export type RoundBrief = z.infer<typeof RoundBriefSchema>;

export const PersonaCritiqueSchema = z.object({
  personaId: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  recommendations: z.array(z.string().min(1)),
});

export type PersonaCritique = z.infer<typeof PersonaCritiqueSchema>;

export const PersonaFailureSchema = z.object({
  personaId: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export type PersonaFailure = z.infer<typeof PersonaFailureSchema>;

export const RawPersonaResultSchema = z.object({
  personaId: z.string().min(1),
  text: z.string(),
  transcript: z.array(z.string()),
  metadata: z.record(z.string(), z.string()).default({}),
});

export type RawPersonaResult = z.infer<typeof RawPersonaResultSchema>;

export const RoundAssessmentSchema = z.object({
  roundNumber: z.number().int().positive(),
  consensus: z.string().min(1),
  disagreements: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  shouldContinue: z.boolean(),
  diminishingReturns: z.boolean(),
  nextRoundBrief: z.string().min(1).optional(),
});

export type RoundAssessment = z.infer<typeof RoundAssessmentSchema>;

export const CouncilReportSchema = z.object({
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)),
  strongestObjections: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  nextExperiment: z.string().min(1),
  failedPersonas: z.array(PersonaFailureSchema),
});

export type CouncilReport = z.infer<typeof CouncilReportSchema>;

export const CouncilRoundSchema = z.object({
  brief: RoundBriefSchema,
  rawResults: z.array(RawPersonaResultSchema),
  critiques: z.array(PersonaCritiqueSchema),
  failures: z.array(PersonaFailureSchema),
  assessment: RoundAssessmentSchema,
});

export type CouncilRound = z.infer<typeof CouncilRoundSchema>;

export const CouncilRunStateSchema = z.object({
  input: CouncilInputSchema,
  personas: z.array(PersonaDefinitionSchema),
  maxRounds: z.number().int().positive(),
  rounds: z.array(CouncilRoundSchema),
  finalReport: CouncilReportSchema.optional(),
  stopReason: z.enum(["consensus", "diminishing-returns", "max-rounds"]).optional(),
});

export type CouncilRunState = z.infer<typeof CouncilRunStateSchema>;

export function createInitialRunState(input: CouncilInput, personaSet: PersonaSet): CouncilRunState {
  const parsedInput = CouncilInputSchema.parse(input);
  const parsedPersonaSet = PersonaSetSchema.parse(personaSet);

  return {
    input: parsedInput,
    personas: parsedPersonaSet.personas,
    maxRounds: 3,
    rounds: [],
  };
}
```

- [ ] **Step 4: Add default personas**

Create `src/council/personas.ts`:

```ts
import { PersonaSetSchema, type PersonaSet } from "./types.js";

export const defaultPersonaSet: PersonaSet = PersonaSetSchema.parse({
  name: "default",
  personas: [
    {
      id: "socratic",
      name: "Socratic Questioner",
      description: "Surfaces hidden assumptions, missing definitions, and questions the design has not answered.",
      prompt:
        "You are the Socratic Questioner. Identify assumptions, ambiguities, and the questions that would most improve this design. Do not solve prematurely.",
    },
    {
      id: "deep-module-dry",
      name: "Deep Module/DRY Architect",
      description: "Critiques seams, interfaces, duplication, module depth, leverage, and locality.",
      prompt:
        "You are the Deep Module/DRY Architect. Evaluate module depth, seams, interface size, duplicated responsibilities, and whether callers get leverage from the design.",
    },
    {
      id: "pragmatic",
      name: "Pragmatic Builder",
      description: "Finds the smallest executable next step and guards against overbuilding.",
      prompt:
        "You are the Pragmatic Builder. Identify the smallest useful next experiment, implementation slice, or prototype that would validate the design.",
    },
    {
      id: "skeptic",
      name: "Skeptic",
      description: "Looks for failure modes, weak evidence, overconfidence, and hidden costs.",
      prompt:
        "You are the Skeptic. Challenge weak evidence, optimistic assumptions, reliability gaps, cost risks, and ways this design could fail.",
    },
  ],
});

export function resolvePersonaSet(personaSet: PersonaSet = defaultPersonaSet): PersonaSet {
  return PersonaSetSchema.parse(structuredClone(personaSet));
}
```

Modify `src/index.ts`:

```ts
export const version = "0.0.0";

export type {
  CouncilInput,
  CouncilReport,
  CouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./council/types.js";
export { defaultPersonaSet, resolvePersonaSet } from "./council/personas.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test -- tests/council/types.test.ts tests/council/personas.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/council/types.ts src/council/personas.ts tests/council/types.test.ts tests/council/personas.test.ts
git commit -m "feat: define council domain types and personas"
```

---

### Task 3: Artifact Rendering and Storage

**Files:**
- Create: `src/council/artifacts.ts`
- Test: `tests/council/artifacts.test.ts`

**Interfaces:**
- Consumes: `CouncilReport`, `CouncilRunState` from Task 2.
- Produces:
  - `renderCouncilReportMarkdown(report: CouncilReport): string`
  - `writeCouncilArtifacts(args: { outputDir: string; state: CouncilRunState }): Promise<CouncilArtifacts>`

- [ ] **Step 1: Write failing artifact tests**

Create `tests/council/artifacts.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCouncilReportMarkdown, writeCouncilArtifacts } from "../../src/council/artifacts";
import type { CouncilRunState } from "../../src/council/types";

const report = {
  recommendation: "Use Flue for v0.",
  rationale: ["It gives typed workflow steps."],
  strongestObjections: ["The API may change."],
  unresolvedQuestions: ["How stable is the Copilot SDK?"],
  confidence: 0.72,
  convergence: 0.81,
  nextExperiment: "Run one council on the Weavekit design.",
  failedPersonas: [],
};

describe("council artifacts", () => {
  it("renders a decision-ready Markdown report", () => {
    const markdown = renderCouncilReportMarkdown(report);

    expect(markdown).toContain("# Design Council Report");
    expect(markdown).toContain("## Recommendation");
    expect(markdown).toContain("Use Flue for v0.");
    expect(markdown).toContain("## Strongest Objections");
    expect(markdown).not.toContain("Raw transcript");
  });

  it("writes Markdown, JSON state, and debug transcripts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-artifacts-"));
    const state: CouncilRunState = {
      input: { prompt: "Question", context: [], constraints: [] },
      personas: [],
      maxRounds: 3,
      rounds: [
        {
          brief: { roundNumber: 1, prompt: "Question", focus: "Initial critique" },
          rawResults: [
            {
              personaId: "socratic",
              text: "Raw answer",
              transcript: ["assistant: Raw answer"],
              metadata: { model: "gpt-5" },
            },
          ],
          critiques: [],
          failures: [],
          assessment: {
            roundNumber: 1,
            consensus: "Continue",
            disagreements: [],
            confidence: 0.5,
            convergence: 0.4,
            shouldContinue: true,
            diminishingReturns: false,
            nextRoundBrief: "Focus on risks.",
          },
        },
      ],
      finalReport: report,
      stopReason: "consensus",
    };

    try {
      const artifacts = await writeCouncilArtifacts({ outputDir, state });

      await expect(readFile(artifacts.reportPath, "utf8")).resolves.toContain("Use Flue for v0.");
      await expect(readFile(artifacts.statePath, "utf8")).resolves.toContain("\"stopReason\": \"consensus\"");
      await expect(readFile(artifacts.debugTranscriptPaths[0]!, "utf8")).resolves.toContain("assistant: Raw answer");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/council/artifacts.test.ts
```

Expected: FAIL because `src/council/artifacts.ts` does not exist.

- [ ] **Step 3: Implement artifact rendering and writing**

Create `src/council/artifacts.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CouncilReport, CouncilRunState, PersonaFailure } from "./types.js";

export type CouncilArtifacts = {
  reportPath: string;
  statePath: string;
  debugTranscriptPaths: string[];
};

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- None\n";
  }

  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function renderFailures(failures: PersonaFailure[]): string {
  if (failures.length === 0) {
    return "- None\n";
  }

  return failures
    .map((failure) => `- ${failure.personaId}: ${failure.message} (retryable: ${failure.retryable})`)
    .join("\n") + "\n";
}

export function renderCouncilReportMarkdown(report: CouncilReport): string {
  return [
    "# Design Council Report",
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

export async function writeCouncilArtifacts(args: {
  outputDir: string;
  state: CouncilRunState;
}): Promise<CouncilArtifacts> {
  const { outputDir, state } = args;

  if (!state.finalReport) {
    throw new Error("Cannot write council artifacts without a final report.");
  }

  await mkdir(outputDir, { recursive: true });
  const debugDir = join(outputDir, "debug");
  await mkdir(debugDir, { recursive: true });

  const reportPath = join(outputDir, "CouncilReport.md");
  const statePath = join(outputDir, "CouncilRunState.json");

  await writeFile(reportPath, renderCouncilReportMarkdown(state.finalReport), "utf8");
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const debugTranscriptPaths: string[] = [];
  for (const round of state.rounds) {
    for (const result of round.rawResults) {
      const transcriptPath = join(debugDir, `round-${round.brief.roundNumber}-${result.personaId}.txt`);
      await writeFile(transcriptPath, result.transcript.join("\n") + "\n", "utf8");
      debugTranscriptPaths.push(transcriptPath);
    }
  }

  return { reportPath, statePath, debugTranscriptPaths };
}
```

- [ ] **Step 4: Run artifact tests and typecheck**

Run:

```bash
npm test -- tests/council/artifacts.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/council/artifacts.ts tests/council/artifacts.test.ts
git commit -m "feat: write council report artifacts"
```

---

### Task 4: BAML Contracts and Adapter Seam

**Files:**
- Create: `baml_src/council.baml`
- Create: `src/council/bamlAdapters.ts`
- Test: `tests/council/bamlAdapters.test.ts`

**Interfaces:**
- Consumes: `RawPersonaResult`, `PersonaCritique`, `RoundAssessment`, `CouncilReport`, `PersonaFailure` from Task 2.
- Produces:
  - `type CritiqueNormalizer`
  - `type JudgeReducer`
  - `class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer`

- [ ] **Step 1: Write failing adapter seam tests**

Create `tests/council/bamlAdapters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CritiqueNormalizer, JudgeReducer } from "../../src/council/bamlAdapters";

describe("BAML adapter seams", () => {
  it("allows tests to replace critique normalization", async () => {
    const normalizer: CritiqueNormalizer = {
      async normalizeCritique({ personaId }) {
        return {
          personaId,
          summary: "Summary",
          claims: ["Claim"],
          risks: ["Risk"],
          questions: ["Question"],
          recommendations: ["Recommendation"],
        };
      },
    };

    await expect(
      normalizer.normalizeCritique({
        personaId: "socratic",
        text: "raw",
        transcript: [],
        metadata: {},
      }),
    ).resolves.toMatchObject({ personaId: "socratic" });
  });

  it("allows tests to replace Judge reduction", async () => {
    const judge: JudgeReducer = {
      async assessRound() {
        return {
          roundNumber: 1,
          consensus: "Enough agreement to stop.",
          disagreements: [],
          confidence: 0.8,
          convergence: 0.9,
          shouldContinue: false,
          diminishingReturns: false,
        };
      },
      async createFinalReport() {
        return {
          recommendation: "Ship v0.",
          rationale: ["The loop is proven."],
          strongestObjections: [],
          unresolvedQuestions: [],
          confidence: 0.8,
          convergence: 0.9,
          nextExperiment: "Run on another design.",
          failedPersonas: [],
        };
      },
    };

    await expect(judge.assessRound({ roundNumber: 1, critiques: [], failures: [] })).resolves.toMatchObject({
      shouldContinue: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/council/bamlAdapters.test.ts
```

Expected: FAIL because `src/council/bamlAdapters.ts` does not exist.

- [ ] **Step 3: Add BAML contract file**

Create `baml_src/council.baml`:

```baml
generator typescript {
  output_type "typescript"
  output_dir "../src/generated"
  default_client_mode "async"
  module_format "esm"
  version "0.220.0"
}

client<llm> DefaultClient {
  provider "openai-generic"
  options {
    base_url env.BAML_OPENAI_BASE_URL
    api_key env.BAML_OPENAI_API_KEY
    model env.BAML_MODEL
  }
}

class RawPersonaResult {
  personaId string
  text string
}

class PersonaCritique {
  personaId string
  summary string
  claims string[]
  risks string[]
  questions string[]
  recommendations string[]
}

class PersonaFailure {
  personaId string
  message string
  retryable bool
}

class RoundAssessment {
  roundNumber int
  consensus string
  disagreements string[]
  confidence float
  convergence float
  shouldContinue bool
  diminishingReturns bool
  nextRoundBrief string?
}

class CouncilReport {
  recommendation string
  rationale string[]
  strongestObjections string[]
  unresolvedQuestions string[]
  confidence float
  convergence float
  nextExperiment string
  failedPersonas PersonaFailure[]
}

function NormalizePersonaCritique(raw: RawPersonaResult) -> PersonaCritique {
  client DefaultClient
  prompt #"
    Normalize this persona response into the requested critique schema.
    Preserve the personaId exactly.

    Persona ID: {{ raw.personaId }}
    Raw response:
    {{ raw.text }}

    {{ ctx.output_format }}
  "#
}

function AssessCouncilRound(
  roundNumber: int,
  critiques: PersonaCritique[],
  failures: PersonaFailure[]
) -> RoundAssessment {
  client DefaultClient
  prompt #"
    You are the Judge reducer for a design council. You are not a debating persona.
    Assess whether the council should continue or stop.
    Continue only when another round is likely to produce materially better guidance.

    Round number: {{ roundNumber }}
    Critiques: {{ critiques }}
    Persona failures: {{ failures }}

    {{ ctx.output_format }}
  "#
}

function CreateCouncilReport(
  critiques: PersonaCritique[],
  assessments: RoundAssessment[],
  failures: PersonaFailure[]
) -> CouncilReport {
  client DefaultClient
  prompt #"
    Create a decision-ready Design Council report.
    Do not write a transcript. Focus on recommendation, rationale, objections,
    unresolved questions, confidence, convergence, and the next experiment.

    Critiques: {{ critiques }}
    Assessments: {{ assessments }}
    Persona failures: {{ failures }}

    {{ ctx.output_format }}
  "#
}
```

- [ ] **Step 4: Add adapter interfaces and generated implementation**

Create `src/council/bamlAdapters.ts`:

```ts
import { b } from "../generated/baml_client/index.js";
import {
  CouncilReportSchema,
  PersonaCritiqueSchema,
  RoundAssessmentSchema,
  type CouncilReport,
  type PersonaCritique,
  type PersonaFailure,
  type RawPersonaResult,
  type RoundAssessment,
} from "./types.js";

export type CritiqueNormalizer = {
  normalizeCritique(raw: RawPersonaResult): Promise<PersonaCritique>;
};

export type JudgeReducer = {
  assessRound(args: {
    roundNumber: number;
    critiques: PersonaCritique[];
    failures: PersonaFailure[];
  }): Promise<RoundAssessment>;
  createFinalReport(args: {
    critiques: PersonaCritique[];
    assessments: RoundAssessment[];
    failures: PersonaFailure[];
  }): Promise<CouncilReport>;
};

export class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer {
  async normalizeCritique(raw: RawPersonaResult): Promise<PersonaCritique> {
    const result = await b.NormalizePersonaCritique({
      personaId: raw.personaId,
      text: raw.text,
    });
    return PersonaCritiqueSchema.parse(result);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: PersonaCritique[];
    failures: PersonaFailure[];
  }): Promise<RoundAssessment> {
    const result = await b.AssessCouncilRound(args.roundNumber, args.critiques, args.failures);
    return RoundAssessmentSchema.parse(result);
  }

  async createFinalReport(args: {
    critiques: PersonaCritique[];
    assessments: RoundAssessment[];
    failures: PersonaFailure[];
  }): Promise<CouncilReport> {
    const result = await b.CreateCouncilReport(args.critiques, args.assessments, args.failures);
    return CouncilReportSchema.parse(result);
  }
}
```

- [ ] **Step 5: Generate BAML client**

Run:

```bash
npm run baml-generate
```

Expected: PASS and `src/generated/baml_client` is created.

- [ ] **Step 6: Run adapter tests and typecheck**

Run:

```bash
npm test -- tests/council/bamlAdapters.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

```bash
git add baml_src/council.baml src/generated src/council/bamlAdapters.ts tests/council/bamlAdapters.test.ts
git commit -m "feat: add baml council contracts"
```

---

### Task 5: Persona Worker and Copilot SDK Adapter

**Files:**
- Create: `src/council/personaWorker.ts`
- Test: `tests/council/personaWorker.test.ts`

**Interfaces:**
- Consumes: `PersonaDefinition`, `RoundBrief`, `RawPersonaResult`.
- Produces:
  - `type PersonaWorker`
  - `class CopilotPersonaWorker implements PersonaWorker`
  - `buildPersonaPrompt(persona, brief): string`

- [ ] **Step 1: Write failing persona worker tests**

Create `tests/council/personaWorker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildPersonaPrompt, CopilotPersonaWorker } from "../../src/council/personaWorker";
import type { PersonaDefinition, RoundBrief } from "../../src/council/types";

const persona: PersonaDefinition = {
  id: "skeptic",
  name: "Skeptic",
  description: "Challenges weak evidence.",
  prompt: "Challenge weak evidence.",
};

const brief: RoundBrief = {
  roundNumber: 1,
  prompt: "Should we use Flue?",
  focus: "Initial critique",
};

describe("persona worker", () => {
  it("builds a prompt with persona instructions and round brief", () => {
    const prompt = buildPersonaPrompt(persona, brief);

    expect(prompt).toContain("Challenge weak evidence.");
    expect(prompt).toContain("Round 1");
    expect(prompt).toContain("Should we use Flue?");
  });

  it("returns raw persona text and transcript from Copilot sendAndWait", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      model: "gpt-5",
    });

    const result = await worker.runPersona({ persona, brief });

    expect(result).toMatchObject({
      personaId: "skeptic",
      text: "Critique text",
    });
    expect(result.transcript[0]).toContain("Critique text");
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5",
        agent: "skeptic",
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/council/personaWorker.test.ts
```

Expected: FAIL because `src/council/personaWorker.ts` does not exist.

- [ ] **Step 3: Implement persona worker**

Create `src/council/personaWorker.ts`:

```ts
import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { PersonaDefinition, RawPersonaResult, RoundBrief } from "./types.js";

type CopilotLikeClient = {
  start(): Promise<void>;
  createSession(config: unknown): Promise<{
    sendAndWait(message: { prompt: string }, timeout?: number): Promise<{ data?: { content?: string } } | undefined>;
    disconnect(): Promise<void>;
  }>;
  stop(): Promise<void>;
};

export type PersonaWorker = {
  runPersona(args: {
    persona: PersonaDefinition;
    brief: RoundBrief;
  }): Promise<RawPersonaResult>;
};

export function buildPersonaPrompt(persona: PersonaDefinition, brief: RoundBrief): string {
  return [
    `You are ${persona.name}.`,
    "",
    persona.prompt,
    "",
    `Round ${brief.roundNumber}`,
    `Focus: ${brief.focus}`,
    "",
    "Design/question:",
    brief.prompt,
    "",
    "Return a concise critique with claims, risks, questions, and recommendations.",
  ].join("\n");
}

export class CopilotPersonaWorker implements PersonaWorker {
  private readonly clientFactory: () => CopilotLikeClient;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(args: {
    clientFactory?: () => CopilotLikeClient;
    model?: string;
    timeoutMs?: number;
  } = {}) {
    this.clientFactory = args.clientFactory ?? (() => new CopilotClient() as CopilotLikeClient);
    this.model = args.model ?? "gpt-5";
    this.timeoutMs = args.timeoutMs ?? 120_000;
  }

  async runPersona(args: { persona: PersonaDefinition; brief: RoundBrief }): Promise<RawPersonaResult> {
    const { persona, brief } = args;
    const client = this.clientFactory();
    await client.start();

    const session = await client.createSession({
      model: this.model,
      agent: persona.id,
      customAgents: [
        {
          name: persona.id,
          displayName: persona.name,
          description: persona.description,
          prompt: persona.prompt,
        },
      ],
      onPermissionRequest: approveAll,
    });

    try {
      const response = await session.sendAndWait({ prompt: buildPersonaPrompt(persona, brief) }, this.timeoutMs);
      const text = response?.data?.content ?? "";

      if (text.trim().length === 0) {
        throw new Error(`Copilot persona ${persona.id} returned an empty response.`);
      }

      return {
        personaId: persona.id,
        text,
        transcript: [`assistant: ${text}`],
        metadata: { model: this.model },
      };
    } finally {
      await session.disconnect();
      await client.stop();
    }
  }
}
```

- [ ] **Step 4: Run persona worker tests and typecheck**

Run:

```bash
npm test -- tests/council/personaWorker.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/council/personaWorker.ts tests/council/personaWorker.test.ts
git commit -m "feat: add copilot persona worker"
```

---

### Task 6: Flue Council Workflow and Public Runner

**Files:**
- Create: `src/council/errors.ts`
- Create: `src/council/workflow.ts`
- Create: `src/council/runner.ts`
- Modify: `src/index.ts`
- Test: `tests/council/runner.test.ts`

**Interfaces:**
- Consumes: `PersonaWorker`, `CritiqueNormalizer`, `JudgeReducer`, `CouncilRunState`, `PersonaSet`.
- Produces:
  - `runCouncil(input: CouncilInput, options?: RunCouncilOptions): Promise<CouncilReport>`
  - `createCouncilWorkflow(deps: CouncilWorkflowDeps)`
  - `CouncilRunFailedError`

- [ ] **Step 1: Write failing runner tests**

Create `tests/council/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCouncil } from "../../src/council/runner";
import { defaultPersonaSet } from "../../src/council/personas";
import type { JudgeReducer, CritiqueNormalizer } from "../../src/council/bamlAdapters";
import type { PersonaWorker } from "../../src/council/personaWorker";

function fakeWorker(failPersonaIds: string[] = []): PersonaWorker {
  return {
    async runPersona({ persona, brief }) {
      if (failPersonaIds.includes(persona.id)) {
        throw new Error(`${persona.id} failed`);
      }

      return {
        personaId: persona.id,
        text: `${persona.name} critique for round ${brief.roundNumber}`,
        transcript: [`assistant: ${persona.name}`],
        metadata: { model: "fake" },
      };
    },
  };
}

const normalizer: CritiqueNormalizer = {
  async normalizeCritique(raw) {
    return {
      personaId: raw.personaId,
      summary: raw.text,
      claims: [`${raw.personaId} claim`],
      risks: [`${raw.personaId} risk`],
      questions: [`${raw.personaId} question`],
      recommendations: [`${raw.personaId} recommendation`],
    };
  },
};

function judge(roundsBeforeStop: number): JudgeReducer {
  return {
    async assessRound({ roundNumber }) {
      return {
        roundNumber,
        consensus: roundNumber >= roundsBeforeStop ? "Stop" : "Continue",
        disagreements: [],
        confidence: roundNumber >= roundsBeforeStop ? 0.8 : 0.4,
        convergence: roundNumber >= roundsBeforeStop ? 0.9 : 0.3,
        shouldContinue: roundNumber < roundsBeforeStop,
        diminishingReturns: false,
        nextRoundBrief: "Focus on remaining objections.",
      };
    },
    async createFinalReport({ failures }) {
      return {
        recommendation: "Use Flue for v0.",
        rationale: ["The workflow loop completed."],
        strongestObjections: ["Framework churn."],
        unresolvedQuestions: [],
        confidence: 0.8,
        convergence: 0.9,
        nextExperiment: "Run the council on a real design.",
        failedPersonas: failures,
      };
    },
  };
}

describe("runCouncil", () => {
  it("runs personas, normalizes critiques, and returns a final report", async () => {
    const report = await runCouncil(
      { prompt: "Should Weavekit use Flue?" },
      {
        personaSet: defaultPersonaSet,
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(1),
          writeArtifacts: false,
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
    expect(report.failedPersonas).toEqual([]);
  });

  it("stops at max three rounds even if Judge asks to continue", async () => {
    const report = await runCouncil(
      { prompt: "Keep debating forever." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(10),
          writeArtifacts: false,
        },
      },
    );

    expect(report.recommendation).toBe("Use Flue for v0.");
  });

  it("fails when fewer than two debating personas succeed", async () => {
    await expect(
      runCouncil(
        { prompt: "Handle failures." },
        {
          deps: {
            personaWorker: fakeWorker(["socratic", "deep-module-dry", "pragmatic"]),
            normalizer,
            judge: judge(1),
            writeArtifacts: false,
          },
        },
      ),
    ).rejects.toThrow("Council requires at least two successful personas.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/council/runner.test.ts
```

Expected: FAIL because `src/council/runner.ts` does not exist.

- [ ] **Step 3: Add explicit error class**

Create `src/council/errors.ts`:

```ts
export class CouncilRunFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CouncilRunFailedError";
    this.exitCode = exitCode;
  }
}
```

- [ ] **Step 4: Add Flue workflow module**

Create `src/council/workflow.ts`:

```ts
import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import type { CritiqueNormalizer, JudgeReducer } from "./bamlAdapters.js";
import { CouncilRunFailedError } from "./errors.js";
import type { PersonaWorker } from "./personaWorker.js";
import {
  CouncilRunStateSchema,
  type CouncilRound,
  type CouncilRunState,
  type PersonaFailure,
  type RawPersonaResult,
  type RoundBrief,
} from "./types.js";

export type CouncilWorkflowDeps = {
  personaWorker: PersonaWorker;
  normalizer: CritiqueNormalizer;
  judge: JudgeReducer;
};

function createRoundBrief(state: CouncilRunState): RoundBrief {
  const roundNumber = state.rounds.length + 1;
  const previous = state.rounds.at(-1);

  return {
    roundNumber,
    prompt: state.input.prompt,
    focus: previous?.assessment.nextRoundBrief ?? "Initial critique",
  };
}

function toFailure(personaId: string, error: unknown): PersonaFailure {
  return {
    personaId,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

export async function runCouncilRound(
  state: CouncilRunState,
  deps: CouncilWorkflowDeps,
): Promise<CouncilRunState> {
  if (state.stopReason || state.finalReport) {
    return state;
  }

  const brief = createRoundBrief(state);
  const rawResults: RawPersonaResult[] = [];
  const failures: PersonaFailure[] = [];

  const personaResults = await Promise.allSettled(
    state.personas.map(async (persona) => deps.personaWorker.runPersona({ persona, brief })),
  );

  for (let index = 0; index < personaResults.length; index += 1) {
    const persona = state.personas[index]!;
    const result = personaResults[index]!;

    if (result.status === "fulfilled") {
      rawResults.push(result.value);
    } else {
      failures.push(toFailure(persona.id, result.reason));
    }
  }

  if (rawResults.length < 2) {
    throw new CouncilRunFailedError("Council requires at least two successful personas.");
  }

  const critiqueResults = await Promise.allSettled(
    rawResults.map(async (raw) => deps.normalizer.normalizeCritique(raw)),
  );

  const critiques = [];
  for (let index = 0; index < critiqueResults.length; index += 1) {
    const raw = rawResults[index]!;
    const result = critiqueResults[index]!;

    if (result.status === "fulfilled") {
      critiques.push(result.value);
    } else {
      failures.push(toFailure(raw.personaId, result.reason));
    }
  }

  if (critiques.length < 2) {
    throw new CouncilRunFailedError("Council requires at least two normalized critiques.");
  }

  const assessment = await deps.judge.assessRound({
    roundNumber: brief.roundNumber,
    critiques,
    failures,
  });

  const round: CouncilRound = {
    brief,
    rawResults,
    critiques,
    failures,
    assessment,
  };

  const rounds = [...state.rounds, round];
  const allCritiques = rounds.flatMap((item) => item.critiques);
  const allFailures = rounds.flatMap((item) => item.failures);
  const assessments = rounds.map((item) => item.assessment);

  const reachedMaxRounds = rounds.length >= state.maxRounds;
  const shouldStop = reachedMaxRounds || !assessment.shouldContinue || assessment.diminishingReturns;

  if (!shouldStop) {
    return { ...state, rounds };
  }

  const finalReport = await deps.judge.createFinalReport({
    critiques: allCritiques,
    assessments,
    failures: allFailures,
  });

  const stopReason = reachedMaxRounds
    ? "max-rounds"
    : assessment.diminishingReturns
      ? "diminishing-returns"
      : "consensus";

  return { ...state, rounds, finalReport, stopReason };
}

export async function runCouncilLoop(
  initialState: CouncilRunState,
  deps: CouncilWorkflowDeps,
): Promise<CouncilRunState> {
  let state = CouncilRunStateSchema.parse(initialState);

  while (!state.stopReason && state.rounds.length < state.maxRounds) {
    state = await runCouncilRound(state, deps);
  }

  return state;
}

export function createCouncilWorkflow(deps: CouncilWorkflowDeps) {
  return defineWorkflow({
    agent: defineAgent(() => ({
      model: "anthropic/claude-haiku-4-5",
      instructions:
        "You host finite Design Council workflow runs. Application code controls the council loop and typed outputs.",
    })),
    input: v.any(),
    output: v.any(),
    async run({ input }) {
      return await runCouncilLoop(CouncilRunStateSchema.parse(input), deps);
    },
  });
}
```

- [ ] **Step 5: Add public runner**

Create `src/council/runner.ts`:

```ts
import { GeneratedBamlAdapters } from "./bamlAdapters.js";
import { writeCouncilArtifacts } from "./artifacts.js";
import { createCouncilWorkflow, runCouncilLoop, type CouncilWorkflowDeps } from "./workflow.js";
import { CopilotPersonaWorker } from "./personaWorker.js";
import { resolvePersonaSet } from "./personas.js";
import { CouncilInputSchema, createInitialRunState, type CouncilInput, type CouncilReport, type PersonaSet } from "./types.js";

export type RunCouncilOptions = {
  personaSet?: PersonaSet;
  outputDir?: string;
  deps?: Partial<CouncilWorkflowDeps> & {
    writeArtifacts?: boolean;
  };
};

export async function runCouncil(input: CouncilInput, options: RunCouncilOptions = {}): Promise<CouncilReport> {
  const parsedInput = CouncilInputSchema.parse(input);
  const personaSet = resolvePersonaSet(options.personaSet);
  const bamlAdapters = new GeneratedBamlAdapters();
  const deps: CouncilWorkflowDeps = {
    personaWorker: options.deps?.personaWorker ?? new CopilotPersonaWorker(),
    normalizer: options.deps?.normalizer ?? bamlAdapters,
    judge: options.deps?.judge ?? bamlAdapters,
  };

  const initialState = createInitialRunState(parsedInput, personaSet);
  createCouncilWorkflow(deps);
  const finalState = await runCouncilLoop(initialState, deps);

  if (!finalState.finalReport) {
    throw new Error("Council workflow completed without a final report.");
  }

  if (options.deps?.writeArtifacts !== false) {
    await writeCouncilArtifacts({
      outputDir: options.outputDir ?? "runs/latest",
      state: finalState,
    });
  }

  return finalState.finalReport;
}
```

Modify `src/index.ts`:

```ts
export const version = "0.0.0";

export type {
  CouncilInput,
  CouncilReport,
  CouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./council/types.js";
export { defaultPersonaSet, resolvePersonaSet } from "./council/personas.js";
export { runCouncil, type RunCouncilOptions } from "./council/runner.js";
```

- [ ] **Step 6: Run runner tests and typecheck**

Run:

```bash
npm test -- tests/council/runner.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/council/errors.ts src/council/workflow.ts src/council/runner.ts tests/council/runner.test.ts
git commit -m "feat: run design council workflow"
```

---

### Task 7: CLI Entrypoint and Example Input

**Files:**
- Create: `src/cli.ts`
- Create: `examples/design-question.md`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `runCouncil`.
- Produces: CLI command `npm run council -- council run --input examples/design-question.md --output runs/example`.

- [ ] **Step 1: Write failing CLI tests**

Create `tests/cli.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCouncilCliArgs, readCouncilInputFile } from "../src/cli";

describe("CLI", () => {
  it("parses council run arguments", () => {
    const parsed = parseCouncilCliArgs([
      "council",
      "run",
      "--input",
      "question.md",
      "--output",
      "runs/question",
    ]);

    expect(parsed).toEqual({
      inputPath: "question.md",
      outputDir: "runs/question",
    });
  });

  it("reads Markdown input into CouncilInput", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-cli-"));
    const inputPath = join(dir, "question.md");

    try {
      await writeFile(inputPath, "# Question\n\nShould we use Flue?", "utf8");
      const input = await readCouncilInputFile(inputPath);
      expect(input.prompt).toContain("Should we use Flue?");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/cli.test.ts
```

Expected: FAIL because `src/cli.ts` does not exist.

- [ ] **Step 3: Add CLI implementation**

Create `src/cli.ts`:

```ts
import { readFile } from "node:fs/promises";
import { runCouncil } from "./council/runner.js";
import type { CouncilInput } from "./council/types.js";

export type CouncilCliArgs = {
  inputPath: string;
  outputDir: string;
};

export function parseCouncilCliArgs(argv: string[]): CouncilCliArgs {
  if (argv[0] !== "council" || argv[1] !== "run") {
    throw new Error("Usage: weavekit council run --input <path> [--output <dir>]");
  }

  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("Missing required --input <path> argument.");
  }

  const outputIndex = argv.indexOf("--output");

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
  };
}

export async function readCouncilInputFile(inputPath: string): Promise<CouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt };
}

async function main(): Promise<void> {
  const args = parseCouncilCliArgs(process.argv.slice(2));
  const input = await readCouncilInputFile(args.inputPath);
  const report = await runCouncil(input, { outputDir: args.outputDir });

  process.stdout.write(`${report.recommendation}\n`);
  process.stdout.write(`Artifacts written to ${args.outputDir}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
```

Create `examples/design-question.md`:

```md
# Design question

Should Weavekit use Flue as the v0 workflow and agent harness layer for a Design Council that orchestrates GitHub Copilot SDK persona sessions and uses BAML for typed fan-in contracts?

Constraints:

- Keep the public interface small.
- Produce Markdown and JSON artifacts.
- Stop in no more than three rounds.
- Avoid web UI and cloud durability in v0.
```

- [ ] **Step 4: Run CLI tests and typecheck**

Run:

```bash
npm test -- tests/cli.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts examples/design-question.md tests/cli.test.ts
git commit -m "feat: add design council cli"
```

---

### Task 8: End-to-End Verification and Documentation

**Files:**
- Create: `README.md`
- Modify: `package.json`
- Test: all tests and build.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: documented local verification commands and v0 usage.

- [ ] **Step 1: Write README with exact v0 usage**

Create `README.md`:

```md
# Weavekit

Weavekit is a TypeScript-first playground for orchestrating GitHub Copilot SDK agents through explicit, typed workflows.

The v0 workflow is a Design Council. It runs four debating personas, normalizes their critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `CouncilReport.md`
- `CouncilRunState.json`
- raw transcript debug files

## Setup

```bash
npm install
npm run baml-generate
```

Set BAML model environment variables before running the real workflow:

```bash
export BAML_OPENAI_BASE_URL="https://api.openai.com/v1"
export BAML_OPENAI_API_KEY="<your-api-key>"
export BAML_MODEL="gpt-5-mini"
```

GitHub Copilot SDK authentication follows the SDK's local authentication behavior.

## Run the Design Council

```bash
npm run council -- council run --input examples/design-question.md --output runs/example
```

## Verify

```bash
npm test
npm run typecheck
npm run build
```
```

- [ ] **Step 2: Run complete test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: `npm run baml-generate` succeeds, then `tsc -p tsconfig.json` succeeds and writes `dist/`.

- [ ] **Step 5: Run CLI help-failure check**

Run:

```bash
npm run council -- council
```

Expected: exits non-zero and prints `Usage: weavekit council run --input <path> [--output <dir>]`.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: document design council usage"
```

---

## Self-Review

**Spec coverage:** This plan covers the approved TypeScript-first stack, Flue workflow and agent harness layer, Copilot persona worker, selected BAML contracts, deep `runCouncil` interface, persona-set escape hatch, decision-ready report, <=3 round stop policy, partial persona failure behavior, typed JSON state, Markdown report, raw debug transcripts, CLI-first interface, and v0 non-goals.

**Placeholder scan:** The plan contains no deferred implementation markers. Each task names exact files, interfaces, commands, and expected outcomes.

**Type consistency:** The public types are introduced in Task 2 and reused consistently by artifacts, BAML adapters, persona workers, workflow, runner, and CLI tasks. The public seam remains `runCouncil(input, options)`.
