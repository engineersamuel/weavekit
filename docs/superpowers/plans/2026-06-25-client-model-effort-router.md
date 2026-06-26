# Client Model + Effort Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fast, deterministic-first router that selects the right BAML client (and optional reasoning effort) per BAML call and the right model + reasoning effort per Copilot SDK persona call, with a guaranteed sub-5-second routing decision.

**Architecture:** A thin `ModelRouter` selection layer — no changes to BAML/SDK internals. A `PolicyModelRouter` returns instant deterministic decisions from a table; an `LlmModelRouter` handles dynamic intent on a fast non-reasoning client (`CopilotProxyClaudeHaiku45`) guarded by an `AbortSignal` hard timeout that falls back to policy; a `HybridModelRouter` composes them with a decision cache. The decision is applied to BAML calls via `__baml_options__` (`{ client }` swap, or a dynamic `ClientRegistry` for effort) and to Copilot SDK calls via `createSession({ model, reasoningEffort })`.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Zod, BAML (`@boundaryml/baml`), GitHub Copilot SDK (`@github/copilot-sdk`), npm scripts, local Copilot proxy at `http://127.0.0.1:8080/v1`.

**Design source:** `docs/research/2026-06-25-client-model-effort-router.md` (research handoff; sections cited inline as §N).

## Global Constraints

- Routing decision must complete in **< 5 s**; enforce with an `AbortSignal` hard cap of `3500` ms in `LlmModelRouter` plus an always-available deterministic policy fallback (research §7).
- The router model itself must be **non-reasoning / minimum effort**; default router client is `CopilotProxyClaudeHaiku45` (`claude-haiku-4-5`) (research §5.3).
- Do **not** modify BAML or Copilot SDK internals, and do **not** edit anything under `src/generated/` by hand; routing is a thin selection layer (research §9). Generated files only change via `npm run baml-generate`.
- All models are reached through the local Copilot proxy `http://127.0.0.1:8080/v1`; published TTFT/TPS numbers are relative guidance only — confirm with the local benchmark (research §8.1).
- **Back-compat:** when no router is injected, `GeneratedBamlAdapters` and `CopilotPersonaWorker` must behave exactly as today (no client/model/effort override). All existing tests must stay green.
- **BAML effort is opt-in:** default BAML routing uses client-name swap only (verified mechanism, research §3a). `reasoning_effort` passthrough via `ClientRegistry` is supported in code but left out of default policy until verified against the proxy (research §8.2).
- **Baseline:** the `council` -> `decision-council` API rename is completed to a green build before Task 1 (see Task 0). `weavekit` is intentionally kept (no glueplane rename); `@boundaryml/baml` is pinned to `0.223.0`; BAML function names are NOT renamed.
- Interface names this plan depends on (current code):
  - BAML file: `baml_src/council.baml`
  - Generated calls: `b.NormalizePersonaCritique`, `b.AssessCouncilRound`, `b.CreateCouncilReport`
  - Public entry: `runDecisionCouncil(input, options?)` exported from `src/decision-council/runner.ts`
  - Adapter methods (stable): `GeneratedBamlAdapters.normalizeCritique`, `.assessRound`, `.createFinalReport`
- TDD: write the failing test first, run it red, implement minimally, run it green, commit. Use `npm test` (Vitest) and `npm run typecheck` (`tsc --noEmit`). After any `baml_src/*.baml` edit, run `npm run baml-generate` and commit the regenerated `src/generated/**` files.

---

## File Structure

**New files:**

- `src/decision-council/modelRouter.ts` — Router domain types (`RoutingDecision`, `RouteRequest`, `ModelRouter`), the default policy table, and `PolicyModelRouter`, `LlmModelRouter`, `HybridModelRouter`, plus `createDefaultModelRouter()` and `ROUTER_CANDIDATES`. One cohesive module; all implementations share the same types.
- `src/decision-council/bamlRouting.ts` — Pure mapping `toBamlCallOptions(decision, env)` from a `RoutingDecision` to BAML `__baml_options__` (`{ client }` or `{ clientRegistry }`). Isolated so it is unit-testable without a live proxy.
- `baml_src/router.baml` — `RoutingDecision` class + `RouteModelCall(taskKind, summary, candidates) -> RoutingDecision`, pinned to `CopilotProxyClaudeHaiku45`.
- `scripts/router-benchmark.ts` — Standalone diagnostic that micro-benchmarks router-model candidates against the live proxy (TTFT + total). Run manually via `tsx`; never part of the Vitest suite.
- `tests/decision-council/modelRouter.test.ts` — Unit tests for policy, LLM timeout/fallback, hybrid + cache.
- `tests/decision-council/bamlRouting.test.ts` — Unit tests for the decision→options mapping.
- `tests/decision-council/routerBaml.test.ts` — File-content assertions for `baml_src/router.baml` (mirrors `tests/decision-council/bamlProviders.test.ts`).
- `tests/decision-council/routerBenchmark.test.ts` — Smoke test that the benchmark module exports the expected candidate list (no network).

**Modified files:**

- `src/decision-council/bamlAdapters.ts` — `GeneratedBamlAdapters` accepts an optional `router`, optional `bamlEnv`, and an injectable BAML client seam; routes each call and threads options into `b.*`.
- `src/decision-council/personaWorker.ts` — `CopilotPersonaWorker` accepts an optional `router`; routes per persona/round and threads `model` + `reasoningEffort` into `createSession`.
- `src/decision-council/runner.ts` — `runDecisionCouncil` constructs the default hybrid router and injects it into the adapters and persona worker; `RunDecisionCouncilOptions` gains an optional `router`.
- `package.json` — add a `bench:router` script for the diagnostic.
- `README.md` — document router behavior, default policy, and the effort/passthrough caveats.

---

### Task 0: Establish a green baseline (prerequisite gate)

This task does no feature work. It verifies the green baseline from Global Constraints (the `council` -> `decision-council` rename completed; `weavekit` kept; baml `0.223.0`). If the build is red, **stop** and finish the rename to green first — do not start router work against a non-compiling tree.

**Files:**
- None (verification only).

- [ ] **Step 1: Install dependencies**

Run: `npm install`
Expected: completes with exit code 0.

- [ ] **Step 2: Verify typecheck is green**

Run: `npm run typecheck`
Expected: exit code 0, no `TS2305`/`TS2307` errors. If you see errors like `Cannot find module './council/runner.js'` or missing `DecisionCouncil*` exports, the rename was left half-finished — finish it to green before proceeding.

- [ ] **Step 3: Verify tests are green**

Run: `npm test`
Expected: all Vitest suites pass.

- [ ] **Step 4: Confirm BAML call symbols exist**

Run: `grep -n "NormalizePersonaCritique\|AssessCouncilRound\|CreateCouncilReport" src/generated/baml_client/async_client.ts`
Expected: at least one match for each (BAML function names are kept, not renamed).

- [ ] **Step 5: Record the baseline**

No commit. Proceed to Task 1 only when Steps 2–4 pass.

---

### Task 1: Router domain types and `PolicyModelRouter`

Create the router module with shared types and the deterministic policy table (research §6.1). The policy is the default and the fallback for every later router.

**Files:**
- Create: `src/decision-council/modelRouter.ts`
- Test: `tests/decision-council/modelRouter.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type ReasoningEffort = "low" | "medium" | "high" | "xhigh"`
  - `type RouteTaskKind = "normalize" | "assess" | "report" | "persona"`
  - `type RouteRequest = { taskKind: RouteTaskKind; summary?: string; roundNumber?: number; personaId?: string; dynamic?: boolean }`
  - `type RoutingDecision = { clientName?: string; model: string; reasoningEffort?: ReasoningEffort; rationale: string }`
  - `interface ModelRouter { route(request: RouteRequest): Promise<RoutingDecision> }`
  - `type RoutingPolicy = Record<RouteTaskKind, RoutingDecision>`
  - `const DEFAULT_ROUTING_POLICY: RoutingPolicy`
  - `class PolicyModelRouter implements ModelRouter` with `constructor(policy?: RoutingPolicy)`

- [ ] **Step 1: Write the failing test**

Create `tests/decision-council/modelRouter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  PolicyModelRouter,
} from "../../src/decision-council/modelRouter.js";

describe("PolicyModelRouter", () => {
  it("returns the fast Haiku client for normalize with no effort override", async () => {
    const router = new PolicyModelRouter();
    const decision = await router.route({ taskKind: "normalize" });

    expect(decision.clientName).toBe("CopilotProxyClaudeHaiku45");
    expect(decision.reasoningEffort).toBeUndefined();
    expect(decision.rationale).toMatch(/\S/);
  });

  it("routes assess and report to the Sonnet judge client", async () => {
    const router = new PolicyModelRouter();
    await expect(router.route({ taskKind: "assess" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
    await expect(router.route({ taskKind: "report" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
  });

  it("routes persona to an SDK model id with no BAML client name", async () => {
    const router = new PolicyModelRouter();
    const decision = await router.route({ taskKind: "persona", personaId: "skeptic" });

    expect(decision.clientName).toBeUndefined();
    expect(decision.model).toBe("claude-sonnet-4.5");
  });

  it("honors a custom policy table", async () => {
    const custom = {
      ...DEFAULT_ROUTING_POLICY,
      normalize: { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "override" },
    };
    const router = new PolicyModelRouter(custom);
    await expect(router.route({ taskKind: "normalize" })).resolves.toMatchObject({
      clientName: "CopilotProxyGrokCodeFast1",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/modelRouter.test.ts`
Expected: FAIL — cannot find module `../../src/decision-council/modelRouter.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/decision-council/modelRouter.ts`:

```ts
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type RouteTaskKind = "normalize" | "assess" | "report" | "persona";

export type RouteRequest = {
  taskKind: RouteTaskKind;
  summary?: string;
  roundNumber?: number;
  personaId?: string;
  /** When true, a HybridModelRouter consults the fast LLM router instead of policy. */
  dynamic?: boolean;
};

export type RoutingDecision = {
  /** A clients.baml client name for BAML calls. Undefined for the Copilot SDK path. */
  clientName?: string;
  /** Concrete model id: a proxy model id for BAML effort routing, or an SDK model id for personas. */
  model: string;
  reasoningEffort?: ReasoningEffort;
  rationale: string;
};

export interface ModelRouter {
  route(request: RouteRequest): Promise<RoutingDecision>;
}

export type RoutingPolicy = Record<RouteTaskKind, RoutingDecision>;

// Defaults from research §6.1. BAML kinds use client-name swap only (no effort) by
// default; effort passthrough is opt-in pending proxy verification (research §8.2).
// The persona default keeps today's SDK model so behavior is unchanged until tuned.
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  normalize: {
    clientName: "CopilotProxyClaudeHaiku45",
    model: "claude-haiku-4-5",
    rationale: "Fast, cheap structured extraction; non-reasoning Haiku.",
  },
  assess: {
    clientName: "CopilotProxyClaudeSonnet46",
    model: "claude-sonnet-4-6",
    rationale: "Mid-reasoning Judge decision.",
  },
  report: {
    clientName: "CopilotProxyClaudeSonnet46",
    model: "claude-sonnet-4-6",
    rationale: "Strong synthesis for the decision-ready report.",
  },
  persona: {
    model: "claude-sonnet-4.5",
    rationale: "Persona debate tier (Copilot SDK model id).",
  },
};

export class PolicyModelRouter implements ModelRouter {
  private readonly policy: RoutingPolicy;

  constructor(policy: RoutingPolicy = DEFAULT_ROUTING_POLICY) {
    this.policy = policy;
  }

  async route(request: RouteRequest): Promise<RoutingDecision> {
    return this.policy[request.taskKind];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/decision-council/modelRouter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/decision-council/modelRouter.ts tests/decision-council/modelRouter.test.ts
git commit -m "feat(router): add ModelRouter types and PolicyModelRouter"
```

---

### Task 2: `RouteModelCall` BAML function on the fast router client

Add a BAML function and result class so the LLM router has a generated `b.RouteModelCall` to call. Pin it to `CopilotProxyClaudeHaiku45` (research §5.3).

**Files:**
- Create: `baml_src/router.baml`
- Modify (generated, via tool): `src/generated/baml_client/**`
- Test: `tests/decision-council/routerBaml.test.ts`

**Interfaces:**
- Consumes: `CopilotProxyClaudeHaiku45` (exists, `baml_src/clients.baml:72`).
- Produces: generated `b.RouteModelCall(taskKind: string, summary: string, candidates: string[], __baml_options__?) -> RoutingDecision` and a generated `RoutingDecision` type.

- [ ] **Step 1: Write the failing test**

Create `tests/decision-council/routerBaml.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("router.baml", () => {
  it("defines RouteModelCall pinned to the fast non-reasoning router client", async () => {
    const router = await readFile("baml_src/router.baml", "utf8");

    expect(router).toContain("class RoutingDecision");
    expect(router).toContain("function RouteModelCall");
    expect(router).toContain("client CopilotProxyClaudeHaiku45");
  });

  it("exposes a generated b.RouteModelCall binding", async () => {
    const generated = await readFile("src/generated/baml_client/async_client.ts", "utf8");

    expect(generated).toContain("RouteModelCall");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/routerBaml.test.ts`
Expected: FAIL — `baml_src/router.baml` does not exist.

- [ ] **Step 3: Create the BAML source**

Create `baml_src/router.baml`:

```baml
class RoutingDecision {
  clientName string?
  model string
  reasoningEffort string?
  rationale string
}

function RouteModelCall(taskKind: string, summary: string, candidates: string[]) -> RoutingDecision {
  client CopilotProxyClaudeHaiku45
  prompt #"
    You are a fast model router for a decision-council workflow. Pick the single best
    option for this task. Respond immediately; do not deliberate.

    Task kind: {{ taskKind }}
    Task summary: {{ summary }}
    Candidate client names (choose clientName from these): {{ candidates }}

    Rules:
    - clientName MUST be one of the candidate names, or null if none fits.
    - model is the concrete model id implied by your choice.
    - reasoningEffort is one of "low", "medium", "high", "xhigh", or null.
    - rationale is one short sentence.

    {{ ctx.output_format }}
  "#
}
```

- [ ] **Step 4: Regenerate the BAML client**

Run: `npm run baml-generate`
Expected: regenerates `src/generated/baml_client/**`; `async_client.ts` now contains a `RouteModelCall` method and `inlinedbaml.ts` includes `router.baml`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/decision-council/routerBaml.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit (include regenerated files)**

```bash
git add baml_src/router.baml src/generated/baml_client tests/decision-council/routerBaml.test.ts
git commit -m "feat(router): add RouteModelCall BAML function on CopilotProxyClaudeHaiku45"
```

---

### Task 3: `LlmModelRouter` with AbortSignal hard timeout and policy fallback

Add the dynamic LLM router. It calls a `RouteModelCallFn` seam (so tests need no proxy), enforces the `3500` ms hard cap, and falls back to a provided `ModelRouter` on timeout, error, or invalid output (research §6 Option C, §7).

**Files:**
- Modify: `src/decision-council/modelRouter.ts`
- Test: `tests/decision-council/modelRouter.test.ts`

**Interfaces:**
- Consumes: `ModelRouter` (Task 1, used as `fallback`).
- Produces:
  - `type RouteModelCallInput = { taskKind: string; summary: string; candidates: string[] }`
  - `type RouteModelCallFn = (input: RouteModelCallInput, signal: AbortSignal) => Promise<RoutingDecision>`
  - `const ROUTER_CANDIDATES: Record<RouteTaskKind, string[]>`
  - `class LlmModelRouter implements ModelRouter` with `constructor(args: { fallback: ModelRouter; callRouteModelCall: RouteModelCallFn; timeoutMs?: number; candidates?: Record<RouteTaskKind, string[]> })`
  - `function isValidDecision(decision: RoutingDecision, taskKind: RouteTaskKind, candidates: string[]): boolean`
  - `function normalizeRoutingDecision(raw: { clientName?: string | null; model?: string | null; reasoningEffort?: string | null; rationale?: string | null }, fallbackModel: string): RoutingDecision`

- [ ] **Step 1: Write the failing test**

Append to `tests/decision-council/modelRouter.test.ts`:

```ts
import {
  LlmModelRouter,
  normalizeRoutingDecision,
  type RouteModelCallFn,
} from "../../src/decision-council/modelRouter.js";

describe("LlmModelRouter", () => {
  it("returns the LLM decision when the call resolves in time", async () => {
    const call: RouteModelCallFn = async () => ({
      clientName: "CopilotProxyGrokCodeFast1",
      model: "grok-code-fast-1",
      reasoningEffort: undefined,
      rationale: "fast",
    });
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: "assess", dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyGrokCodeFast1",
    });
  });

  it("falls back to policy when the call exceeds the timeout", async () => {
    const call: RouteModelCallFn = (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const router = new LlmModelRouter({
      fallback: new PolicyModelRouter(),
      callRouteModelCall: call,
      timeoutMs: 20,
    });

    const decision = await router.route({ taskKind: "assess" });
    expect(decision.clientName).toBe("CopilotProxyClaudeSonnet46");
  });

  it("falls back to policy when the call throws", async () => {
    const call: RouteModelCallFn = async () => {
      throw new Error("proxy down");
    };
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: "normalize" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeHaiku45",
    });
  });

  it("falls back to policy when the LLM returns a client not in the candidates", async () => {
    const call: RouteModelCallFn = async () => ({
      clientName: "CopilotProxyHallucinated",
      model: "made-up",
      rationale: "bad",
    });
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: "assess", dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
  });

  it("enforces the timeout even when the call ignores the abort signal", async () => {
    // This call never settles and never observes the signal — only the independent
    // rejectAfter race can rescue it. Proves the sub-5s guarantee does not depend on
    // the underlying call honoring AbortSignal.
    const call: RouteModelCallFn = () => new Promise<never>(() => {});
    const router = new LlmModelRouter({
      fallback: new PolicyModelRouter(),
      callRouteModelCall: call,
      timeoutMs: 20,
    });

    const start = Date.now();
    const decision = await router.route({ taskKind: "report" });
    expect(decision.clientName).toBe("CopilotProxyClaudeSonnet46");
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("normalizeRoutingDecision", () => {
  it("coerces null/invalid effort to undefined and fills the model", () => {
    const decision = normalizeRoutingDecision(
      { clientName: "X", model: null, reasoningEffort: "turbo", rationale: null },
      "claude-haiku-4-5",
    );
    expect(decision).toEqual({
      clientName: "X",
      model: "claude-haiku-4-5",
      reasoningEffort: undefined,
      rationale: "",
    });
  });

  it("keeps a valid effort", () => {
    const decision = normalizeRoutingDecision(
      { clientName: "X", model: "m", reasoningEffort: "high", rationale: "r" },
      "fallback",
    );
    expect(decision.reasoningEffort).toBe("high");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/modelRouter.test.ts`
Expected: FAIL — `LlmModelRouter` / `normalizeRoutingDecision` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/decision-council/modelRouter.ts`:

```ts
export type RouteModelCallInput = {
  taskKind: string;
  summary: string;
  candidates: string[];
};

export type RouteModelCallFn = (
  input: RouteModelCallInput,
  signal: AbortSignal,
) => Promise<RoutingDecision>;

// Candidate client names (BAML kinds) / SDK model ids (persona) offered to the LLM router.
export const ROUTER_CANDIDATES: Record<RouteTaskKind, string[]> = {
  normalize: ["CopilotProxyClaudeHaiku45", "CopilotProxyGrokCodeFast1", "CopilotProxyGpt5Mini"],
  assess: ["CopilotProxyClaudeSonnet46", "CopilotProxyGpt54"],
  report: ["CopilotProxyClaudeSonnet46", "CopilotProxyClaudeOpus48", "CopilotProxyGpt55"],
  persona: ["claude-sonnet-4.5", "claude-sonnet-4.6", "gpt-5.4"],
};

const VALID_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

export function normalizeRoutingDecision(
  raw: {
    clientName?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    rationale?: string | null;
  },
  fallbackModel: string,
): RoutingDecision {
  const effort = raw.reasoningEffort ?? undefined;
  return {
    clientName: raw.clientName ?? undefined,
    model: raw.model ?? fallbackModel,
    reasoningEffort: effort && VALID_EFFORTS.has(effort) ? (effort as ReasoningEffort) : undefined,
    rationale: raw.rationale ?? "",
  };
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`router timeout after ${ms}ms`)), ms);
  });
}

// A decision is only trusted if it stays within the offered candidates: for the persona
// (SDK) path the model id must be a candidate; for BAML kinds the clientName must be a
// candidate client. Anything else (hallucinated client/model) is rejected -> policy fallback.
export function isValidDecision(
  decision: RoutingDecision,
  taskKind: RouteTaskKind,
  candidates: string[],
): boolean {
  if (!decision.model) {
    return false;
  }
  if (taskKind === "persona") {
    return candidates.includes(decision.model);
  }
  return decision.clientName !== undefined && candidates.includes(decision.clientName);
}

export class LlmModelRouter implements ModelRouter {
  private readonly fallback: ModelRouter;
  private readonly callRouteModelCall: RouteModelCallFn;
  private readonly timeoutMs: number;
  private readonly candidates: Record<RouteTaskKind, string[]>;

  constructor(args: {
    fallback: ModelRouter;
    callRouteModelCall: RouteModelCallFn;
    timeoutMs?: number;
    candidates?: Record<RouteTaskKind, string[]>;
  }) {
    this.fallback = args.fallback;
    this.callRouteModelCall = args.callRouteModelCall;
    this.timeoutMs = args.timeoutMs ?? 3500;
    this.candidates = args.candidates ?? ROUTER_CANDIDATES;
  }

  async route(request: RouteRequest): Promise<RoutingDecision> {
    const candidates = this.candidates[request.taskKind];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const decision = await Promise.race([
        this.callRouteModelCall(
          {
            taskKind: request.taskKind,
            summary: request.summary ?? "",
            candidates,
          },
          controller.signal,
        ),
        rejectAfter(this.timeoutMs),
      ]);
      if (!isValidDecision(decision, request.taskKind, candidates)) {
        return this.fallback.route(request);
      }
      return decision;
    } catch {
      return this.fallback.route(request);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/decision-council/modelRouter.test.ts`
Expected: PASS (all `PolicyModelRouter`, `LlmModelRouter`, and `normalizeRoutingDecision` cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/decision-council/modelRouter.ts tests/decision-council/modelRouter.test.ts
git commit -m "feat(router): add LlmModelRouter with abort-timeout fallback to policy"
```

---

### Task 4: `HybridModelRouter` with decision cache

Compose policy + LLM. Static requests resolve by policy instantly; dynamic requests consult the LLM router (which itself falls back to policy) and cache the result by `(taskKind, coarse summary)` (research §6 Option C, §6.1).

**Files:**
- Modify: `src/decision-council/modelRouter.ts`
- Test: `tests/decision-council/modelRouter.test.ts`

**Interfaces:**
- Consumes: `ModelRouter` (policy and llm).
- Produces:
  - `class HybridModelRouter implements ModelRouter` with `constructor(args: { policy: ModelRouter; llm?: ModelRouter })`
  - `function createDefaultModelRouter(callRouteModelCall?: RouteModelCallFn): ModelRouter`

- [ ] **Step 1: Write the failing test**

Append to `tests/decision-council/modelRouter.test.ts`:

```ts
import {
  HybridModelRouter,
  createDefaultModelRouter,
} from "../../src/decision-council/modelRouter.js";

describe("HybridModelRouter", () => {
  it("uses policy for static requests without calling the LLM", async () => {
    let llmCalls = 0;
    const llm = {
      async route() {
        llmCalls += 1;
        return { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "x" };
      },
    };
    const router = new HybridModelRouter({ policy: new PolicyModelRouter(), llm });

    const decision = await router.route({ taskKind: "normalize" });
    expect(decision.clientName).toBe("CopilotProxyClaudeHaiku45");
    expect(llmCalls).toBe(0);
  });

  it("consults the LLM for dynamic requests and caches by task + summary", async () => {
    let llmCalls = 0;
    const llm = {
      async route() {
        llmCalls += 1;
        return { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "x" };
      },
    };
    const router = new HybridModelRouter({ policy: new PolicyModelRouter(), llm });

    await router.route({ taskKind: "assess", summary: "same", dynamic: true });
    await router.route({ taskKind: "assess", summary: "same", dynamic: true });
    expect(llmCalls).toBe(1);
  });

  it("falls back to policy for dynamic requests when no LLM router is configured", async () => {
    const router = new HybridModelRouter({ policy: new PolicyModelRouter() });
    await expect(router.route({ taskKind: "report", dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
  });
});

describe("createDefaultModelRouter", () => {
  it("returns a router that resolves static decisions from policy", async () => {
    const router = createDefaultModelRouter(async () => {
      throw new Error("LLM should not be called for static requests");
    });
    await expect(router.route({ taskKind: "normalize" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeHaiku45",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/modelRouter.test.ts`
Expected: FAIL — `HybridModelRouter` / `createDefaultModelRouter` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/decision-council/modelRouter.ts`:

```ts
export class HybridModelRouter implements ModelRouter {
  private readonly policy: ModelRouter;
  private readonly llm?: ModelRouter;
  private readonly cache = new Map<string, RoutingDecision>();

  constructor(args: { policy: ModelRouter; llm?: ModelRouter }) {
    this.policy = args.policy;
    this.llm = args.llm;
  }

  async route(request: RouteRequest): Promise<RoutingDecision> {
    if (!request.dynamic || !this.llm) {
      return this.policy.route(request);
    }
    const key = `${request.taskKind}:${(request.summary ?? "").slice(0, 80)}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const decision = await this.llm.route(request);
    this.cache.set(key, decision);
    return decision;
  }
}

// Default production router: policy default + LLM for dynamic intent, the LLM guarded
// by an abort-timeout that falls back to policy. The callRouteModelCall seam is injected
// so the runner can pass the generated b.RouteModelCall wrapper (see bamlAdapters wiring).
export function createDefaultModelRouter(callRouteModelCall?: RouteModelCallFn): ModelRouter {
  const policy = new PolicyModelRouter();
  if (!callRouteModelCall) {
    return new HybridModelRouter({ policy });
  }
  const llm = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall });
  return new HybridModelRouter({ policy, llm });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/decision-council/modelRouter.test.ts`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/decision-council/modelRouter.ts tests/decision-council/modelRouter.test.ts
git commit -m "feat(router): add HybridModelRouter with decision cache and default factory"
```

---

### Task 5: `toBamlCallOptions` decision→BAML options mapping

Pure mapping from a `RoutingDecision` to BAML `__baml_options__`. Default path is the verified client-name swap (research §3a); when an effort is present and proxy connection details are available, build a dynamic `ClientRegistry` (research §3b, §8.2).

**Files:**
- Create: `src/decision-council/bamlRouting.ts`
- Test: `tests/decision-council/bamlRouting.test.ts`

**Interfaces:**
- Consumes: `RoutingDecision` (Task 1); `ClientRegistry` from `@boundaryml/baml`.
- Produces:
  - `type BamlEnv = { baseUrl?: string; apiKey?: string }`
  - `type BamlRouteOptions = { client?: string; clientRegistry?: ClientRegistry }`
  - `function toBamlCallOptions(decision: RoutingDecision | undefined, env?: BamlEnv): BamlRouteOptions`

- [ ] **Step 1: Write the failing test**

Create `tests/decision-council/bamlRouting.test.ts`:

```ts
import { ClientRegistry } from "@boundaryml/baml";
import { describe, expect, it } from "vitest";
import { toBamlCallOptions } from "../../src/decision-council/bamlRouting.js";

describe("toBamlCallOptions", () => {
  it("returns an empty object when there is no decision", () => {
    expect(toBamlCallOptions(undefined)).toEqual({});
  });

  it("swaps client by name when no effort is requested", () => {
    const options = toBamlCallOptions({
      clientName: "CopilotProxyClaudeHaiku45",
      model: "claude-haiku-4-5",
      rationale: "fast",
    });
    expect(options).toEqual({ client: "CopilotProxyClaudeHaiku45" });
  });

  it("builds a dynamic ClientRegistry when effort and proxy details are present", () => {
    const options = toBamlCallOptions(
      { clientName: "CopilotProxyGpt55", model: "gpt-5.5", reasoningEffort: "high", rationale: "deep" },
      { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" },
    );
    expect(options.clientRegistry).toBeInstanceOf(ClientRegistry);
    expect(options.client).toBeUndefined();
  });

  it("falls back to client-name swap when effort is set but no base url is available", () => {
    const options = toBamlCallOptions(
      { clientName: "CopilotProxyGpt55", model: "gpt-5.5", reasoningEffort: "high", rationale: "deep" },
      {},
    );
    expect(options).toEqual({ client: "CopilotProxyGpt55" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/bamlRouting.test.ts`
Expected: FAIL — `bamlRouting.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/decision-council/bamlRouting.ts`:

```ts
import { ClientRegistry } from "@boundaryml/baml";
import type { RoutingDecision } from "./modelRouter.js";

export type BamlEnv = { baseUrl?: string; apiKey?: string };

export type BamlRouteOptions = { client?: string; clientRegistry?: ClientRegistry };

// Mapping rules (research §3):
//  - No decision -> no override (back-compat: DefaultClient).
//  - Effort requested AND proxy base url known -> dynamic ClientRegistry (mechanism b).
//  - Otherwise -> swap client by name (mechanism a, verified).
export function toBamlCallOptions(
  decision: RoutingDecision | undefined,
  env: BamlEnv = {},
): BamlRouteOptions {
  if (!decision) {
    return {};
  }

  if (decision.reasoningEffort && env.baseUrl) {
    const registry = new ClientRegistry();
    registry.addLlmClient("RoutedDecisionClient", "openai-generic", {
      base_url: env.baseUrl,
      api_key: env.apiKey ?? "",
      model: decision.model,
      reasoning_effort: decision.reasoningEffort,
    });
    registry.setPrimary("RoutedDecisionClient");
    return { clientRegistry: registry };
  }

  if (decision.clientName) {
    return { client: decision.clientName };
  }

  return {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/decision-council/bamlRouting.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/decision-council/bamlRouting.ts tests/decision-council/bamlRouting.test.ts
git commit -m "feat(router): map routing decisions to BAML call options"
```

---

### Task 6: Thread routing into `GeneratedBamlAdapters`

Give the BAML adapter an optional router, an injectable BAML client seam (for testing), and proxy env. Each method routes by task kind and threads the options into the generated call. No router injected = today's behavior.

**Files:**
- Modify: `src/decision-council/bamlAdapters.ts`
- Test: `tests/decision-council/bamlAdapters.test.ts` (extend existing)

**Interfaces:**
- Consumes: `ModelRouter` (Task 1), `toBamlCallOptions` + `BamlEnv` (Task 5), generated `b` (`b.NormalizePersonaCritique`, `b.AssessCouncilRound`, `b.CreateCouncilReport` — BAML names unchanged).
- Produces:
  - `type RoutableBamlClient` (structural seam with the three methods this adapter calls).
  - `class GeneratedBamlAdapters` with `constructor(args?: { router?: ModelRouter; bamlEnv?: BamlEnv; bamlClient?: RoutableBamlClient })`. Existing methods keep the same return contract.

- [ ] **Step 1: Write the failing test**

Append to `tests/decision-council/bamlAdapters.test.ts` (post-rename this file imports from `../../src/decision-council/...`):

```ts
import { GeneratedBamlAdapters, type RoutableBamlClient } from "../../src/decision-council/bamlAdapters.js";
import { PolicyModelRouter } from "../../src/decision-council/modelRouter.js";
import type { DecisionPersonaCritique, DecisionRoundAssessment, DecisionCouncilReport } from "../../src/decision-council/types.js";

function fakeBamlClient(capture: { options: unknown[] }): RoutableBamlClient {
  const critique: DecisionPersonaCritique = {
    personaId: "skeptic",
    overallSummary: "ok",
    summary: "ok",
    claims: ["c"],
    risks: ["r"],
    questions: ["q"],
    recommendations: ["rec"],
  };
  const assessment: DecisionRoundAssessment = {
    roundNumber: 1,
    consensus: "stop",
    disagreements: [],
    confidence: 0.8,
    convergence: 0.9,
    shouldContinue: false,
    diminishingReturns: false,
  };
  const report: DecisionCouncilReport = {
    recommendation: "ship",
    rationale: ["r"],
    strongestObjections: [],
    unresolvedQuestions: [],
    confidence: 0.8,
    convergence: 0.9,
    nextExperiment: "try",
    finalReportMarkdown: "# Decision Council Report\n\nShip.",
    failedPersonas: [],
  };
  return {
    async NormalizePersonaCritique(_args, options) {
      capture.options.push(options);
      return critique;
    },
    async AssessCouncilRound(_round, _critiques, _failures, options) {
      capture.options.push(options);
      return assessment;
    },
    async CreateCouncilReport(_critiques, _assessments, _failures, options) {
      capture.options.push(options);
      return report;
    },
  };
}

describe("GeneratedBamlAdapters routing", () => {
  it("passes the policy client for normalize calls", async () => {
    const capture = { options: [] as unknown[] };
    const adapters = new GeneratedBamlAdapters({
      router: new PolicyModelRouter(),
      bamlClient: fakeBamlClient(capture),
      bamlEnv: {},
    });

    await adapters.normalizeCritique({ personaId: "skeptic", text: "raw", transcript: [], metadata: {} });
    expect(capture.options[0]).toEqual({ client: "CopilotProxyClaudeHaiku45" });
  });

  it("passes no override when no router is configured (back-compat)", async () => {
    const capture = { options: [] as unknown[] };
    const adapters = new GeneratedBamlAdapters({ bamlClient: fakeBamlClient(capture) });

    await adapters.assessRound({ roundNumber: 1, critiques: [], failures: [] });
    expect(capture.options[0]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/bamlAdapters.test.ts`
Expected: FAIL — `GeneratedBamlAdapters` does not accept constructor args / `RoutableBamlClient` not exported.

- [ ] **Step 3: Write the implementation**

Replace the body of `src/decision-council/bamlAdapters.ts` with (note: imports use the post-rename `Decision*` names already present in `types.ts`). The generated `BamlCallOptions` type is **not** exported from the BAML client, so the seam uses the locally-defined `BamlRouteOptions` (`{ client?, clientRegistry? }`), which is a valid subset of the options the real `b.*` methods accept:

```ts
import { b } from "../generated/baml_client/index.js";
import { toBamlCallOptions, type BamlEnv, type BamlRouteOptions } from "./bamlRouting.js";
import type { ModelRouter, RouteTaskKind } from "./modelRouter.js";
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

// Structural seam over the generated client so adapters can be tested without a live proxy.
export type RoutableBamlClient = {
  NormalizePersonaCritique(
    args: { personaId: string; text: string },
    options?: BamlRouteOptions,
  ): Promise<DecisionPersonaCritique>;
  AssessCouncilRound(
    roundNumber: number,
    critiques: DecisionPersonaCritique[],
    failures: DecisionPersonaFailure[],
    options?: BamlRouteOptions,
  ): Promise<DecisionRoundAssessment>;
  CreateCouncilReport(
    critiques: DecisionPersonaCritique[],
    assessments: DecisionRoundAssessment[],
    failures: DecisionPersonaFailure[],
    options?: BamlRouteOptions,
  ): Promise<DecisionCouncilReport>;
};

export class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer {
  private readonly router?: ModelRouter;
  private readonly bamlEnv: BamlEnv;
  private readonly client: RoutableBamlClient;

  constructor(args: { router?: ModelRouter; bamlEnv?: BamlEnv; bamlClient?: RoutableBamlClient } = {}) {
    this.router = args.router;
    this.bamlEnv = args.bamlEnv ?? {
      baseUrl: process.env.COPILOT_PROXY_BASE_URL,
      apiKey: process.env.COPILOT_PROXY_API_KEY,
    };
    this.client = args.bamlClient ?? (b as unknown as RoutableBamlClient);
  }

  private async optionsFor(taskKind: RouteTaskKind, summary?: string): Promise<BamlRouteOptions | undefined> {
    if (!this.router) {
      return undefined;
    }
    const decision = await this.router.route({ taskKind, summary });
    return toBamlCallOptions(decision, this.bamlEnv);
  }

  async normalizeCritique(raw: RawPersonaResult): Promise<DecisionPersonaCritique> {
    const options = await this.optionsFor("normalize", raw.text);
    const result = await this.client.NormalizePersonaCritique(
      { personaId: raw.personaId, text: raw.text },
      options,
    );
    return DecisionPersonaCritiqueSchema.parse(result);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment> {
    const options = await this.optionsFor("assess");
    const result = await this.client.AssessCouncilRound(
      args.roundNumber,
      args.critiques,
      args.failures,
      options,
    );
    return DecisionRoundAssessmentSchema.parse(result);
  }

  async createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport> {
    const options = await this.optionsFor("report");
    const result = await this.client.CreateCouncilReport(
      args.critiques,
      args.assessments,
      args.failures,
      options,
    );
    return DecisionCouncilReportSchema.parse(result);
  }
}
```

Note: `toBamlCallOptions` returns `{}` for "no override". When the router is absent, `optionsFor` returns `undefined` so the generated call receives no second argument — identical to today. When a router is present but yields `{}`, the empty object is a valid no-op `__baml_options__`.

- [ ] **Step 4: Run the adapter tests**

Run: `npm test -- tests/decision-council/bamlAdapters.test.ts`
Expected: PASS — both new routing tests and the pre-existing seam tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0. The seam casts the real client with `b as unknown as RoutableBamlClient`, so the structural `BamlRouteOptions` param does not need to match the generated `BamlCallOptions` exactly; at runtime `{ client }` / `{ clientRegistry }` are valid `__baml_options__` fields.

- [ ] **Step 6: Commit**

```bash
git add src/decision-council/bamlAdapters.ts tests/decision-council/bamlAdapters.test.ts
git commit -m "feat(router): route BAML adapter calls through ModelRouter"
```

---

### Task 7: Thread routing into `CopilotPersonaWorker` and `runDecisionCouncil`

Route the persona (Copilot SDK) path per persona/round, threading `model` + `reasoningEffort` into `createSession`, and wire the default hybrid router through `runDecisionCouncil`. No router = today's behavior (`claude-sonnet-4.5`, no effort). **Effort safety (research §4, §8.4):** sending `reasoningEffort` to a model that does not support it can error, so the worker only forwards effort when an injected `supportsReasoningEffort` predicate confirms support; the default predicate returns `false`, so effort is omitted until an operator wires `listModels()`-derived capability in.

**Files:**
- Modify: `src/decision-council/personaWorker.ts`
- Modify: `src/decision-council/runner.ts`
- Test: `tests/decision-council/personaWorker.test.ts` (extend existing)
- Test: `tests/decision-council/runner.test.ts` (extend existing)

**Interfaces:**
- Consumes: `ModelRouter`, `createDefaultModelRouter`, `defaultRouteModelCall` (see Step 5), `RoutingDecision`.
- Produces:
  - `CopilotPersonaWorker` constructor gains `router?: ModelRouter` and `supportsReasoningEffort?: (model: string) => boolean` (default `() => false`).
  - `defaultRouteModelCall: RouteModelCallFn` exported from `modelRouter.ts` (wraps generated `b.RouteModelCall`).
  - `RunDecisionCouncilOptions` gains `router?: ModelRouter`.

- [ ] **Step 1: Write the failing persona-worker test**

Append to `tests/decision-council/personaWorker.test.ts`:

```ts
import type { ModelRouter } from "../../src/decision-council/modelRouter.js";

describe("persona worker routing", () => {
  it("threads routed model and reasoningEffort into createSession", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const router: ModelRouter = {
      async route() {
        return { model: "gpt-5.4", reasoningEffort: "medium", rationale: "tier" };
      },
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      router,
      supportsReasoningEffort: () => true,
    });
    const result = await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as { model: string; reasoningEffort?: string };
    expect(config.model).toBe("gpt-5.4");
    expect(config.reasoningEffort).toBe("medium");
    expect(result.metadata.model).toBe("gpt-5.4");
  });

  it("omits reasoningEffort when the model does not support it, even if routed", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const router: ModelRouter = {
      async route() {
        return { model: "claude-sonnet-4.5", reasoningEffort: "high", rationale: "tier" };
      },
    };

    // No supportsReasoningEffort predicate -> default () => false -> effort omitted.
    const worker = new CopilotPersonaWorker({ clientFactory: () => client, router });
    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as { model: string; reasoningEffort?: string };
    expect(config.model).toBe("claude-sonnet-4.5");
    expect(config.reasoningEffort).toBeUndefined();
  });

  it("omits reasoningEffort and uses the constructor model when no router is set", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new CopilotPersonaWorker({ clientFactory: () => client, model: "claude-sonnet-4.5" });
    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as { model: string; reasoningEffort?: string };
    expect(config.model).toBe("claude-sonnet-4.5");
    expect(config.reasoningEffort).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/personaWorker.test.ts`
Expected: FAIL — `CopilotPersonaWorker` does not accept `router`.

- [ ] **Step 3: Implement persona-worker routing**

In `src/decision-council/personaWorker.ts`:

Add an import near the top:

```ts
import type { ModelRouter } from "./modelRouter.js";
```

Add the fields and constructor args (alongside the existing `model` field):

```ts
  private readonly router?: ModelRouter;
  private readonly supportsReasoningEffort: (model: string) => boolean;
```

In the constructor signature add `router?: ModelRouter;` and `supportsReasoningEffort?: (model: string) => boolean;`, then assign `this.router = args.router;` and `this.supportsReasoningEffort = args.supportsReasoningEffort ?? (() => false);`.

Replace the `createSession` block in `runPersona` (currently `personaWorker.ts:140-152`) so the routed values are applied. Effort is only forwarded when the capability predicate confirms the model supports it (research §4, §8.4):

```ts
      const decision = this.router
        ? await this.router.route({
            taskKind: "persona",
            personaId: persona.id,
            roundNumber: brief.roundNumber,
            summary: brief.prompt,
          })
        : undefined;
      const model = decision?.model ?? this.model;

      const sessionConfig: {
        model: string;
        reasoningEffort?: string;
        agent: string;
        customAgents: Array<{ name: string; displayName: string; description: string; prompt: string }>;
        onPermissionRequest: () => { kind: "approved" | "denied" };
      } = {
        model,
        agent: persona.id,
        customAgents: [
          {
            name: persona.id,
            displayName: persona.name,
            description: persona.description,
            prompt: persona.prompt,
          },
        ],
        onPermissionRequest: this.onPermissionRequest,
      };
      if (decision?.reasoningEffort && this.supportsReasoningEffort(model)) {
        sessionConfig.reasoningEffort = decision.reasoningEffort;
      }

      const session = await client.createSession(sessionConfig);
```

Then update the success result so metadata records the routed model (currently `personaWorker.ts:167` uses `this.model`):

```ts
        successResult = {
          personaId: persona.id,
          text,
          transcript: [`assistant: ${text}`],
          metadata: { model },
        };
```

- [ ] **Step 4: Run the persona-worker tests**

Run: `npm test -- tests/decision-council/personaWorker.test.ts`
Expected: PASS — new routing tests plus all pre-existing tests.

- [ ] **Step 5: Add `defaultRouteModelCall` to `modelRouter.ts`**

Append to `src/decision-council/modelRouter.ts`:

```ts
import { b } from "../generated/baml_client/index.js";

// Production seam: wraps the generated RouteModelCall, passing the abort signal so the
// hard timeout actually cancels the proxy request. The fallback model is the policy model
// for this task kind (a real model id) — NOT input.candidates[0], which for BAML kinds is
// a client name like "CopilotProxyClaudeHaiku45", not a model id.
export const defaultRouteModelCall: RouteModelCallFn = async (input, signal) => {
  const raw = await b.RouteModelCall(input.taskKind, input.summary, input.candidates, { signal });
  const policyModel = DEFAULT_ROUTING_POLICY[input.taskKind as RouteTaskKind]?.model ?? "claude-haiku-4-5";
  return normalizeRoutingDecision(
    {
      clientName: raw.clientName ?? undefined,
      model: raw.model,
      reasoningEffort: raw.reasoningEffort ?? undefined,
      rationale: raw.rationale,
    },
    policyModel,
  );
};
```

Note: keep this import at the top of the file with the other imports when implementing; it is shown here for placement clarity. Run `npm run typecheck` and confirm `b.RouteModelCall` exists (created in Task 2).

- [ ] **Step 6: Write the failing runner wiring test**

Append to `tests/decision-council/runner.test.ts` a test that confirms a custom router is accepted and used. Use the existing fake-deps pattern in that file; assert that when `options.router` is provided and a fake persona worker captures its constructor, routing is wired. Minimal version:

```ts
import { runDecisionCouncil } from "../../src/decision-council/runner.js";
import type { ModelRouter } from "../../src/decision-council/modelRouter.js";

it("accepts a custom router without breaking the run", async () => {
  const router: ModelRouter = {
    async route() {
      return { clientName: "CopilotProxyClaudeHaiku45", model: "claude-haiku-4-5", rationale: "test" };
    },
  };

  // Reuse this file's existing fake personaWorker/normalizer/judge deps so no proxy is hit.
  const report = await runDecisionCouncil(validInput, {
    router,
    deps: { writeArtifacts: false, personaWorker: fakeWorker, normalizer: fakeNormalizer, judge: fakeJudge },
  });

  expect(report.recommendation).toBeDefined();
});
```

Adapt `validInput`, `fakeWorker`, `fakeNormalizer`, `fakeJudge` to the helpers already defined in `runner.test.ts`.

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- tests/decision-council/runner.test.ts`
Expected: FAIL — `RunDecisionCouncilOptions` has no `router`.

- [ ] **Step 8: Implement runner wiring**

In `src/decision-council/runner.ts`:

Add imports:

```ts
import { createDefaultModelRouter, defaultRouteModelCall, type ModelRouter } from "./modelRouter.js";
```

Add `router?: ModelRouter;` to `RunDecisionCouncilOptions`.

In `runDecisionCouncil`, build the router once and inject it into the adapters and the default persona worker (replacing the current `new GeneratedBamlAdapters()` and `new CopilotPersonaWorker()` construction, post-rename around `runner.ts:31-33`):

```ts
  const router = options.router ?? createDefaultModelRouter(defaultRouteModelCall);
  const bamlAdapters = new GeneratedBamlAdapters({ router });
  const deps: DecisionCouncilWorkflowDeps = {
    personaWorker: options.deps?.personaWorker ?? new CopilotPersonaWorker({ router }),
    normalizer: options.deps?.normalizer ?? bamlAdapters,
    judge: options.deps?.judge ?? bamlAdapters,
    logger: options.logger,
    runId,
  };
```

(Names `DecisionCouncilWorkflowDeps`, `runDecisionCouncilLoop`, `DecisionCouncilInputSchema`, `DecisionCouncilRunFailedError` are the current `src/decision-council` exports.)

- [ ] **Step 9: Run the runner tests**

Run: `npm test -- tests/decision-council/runner.test.ts`
Expected: PASS — new wiring test plus all pre-existing tests.

- [ ] **Step 10: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit code 0.

```bash
git add src/decision-council/personaWorker.ts src/decision-council/runner.ts src/decision-council/modelRouter.ts tests/decision-council/personaWorker.test.ts tests/decision-council/runner.test.ts
git commit -m "feat(router): route Copilot SDK persona calls and wire default router into runDecisionCouncil"
```

---

### Task 8: Proxy micro-benchmark for the router model

Add a standalone diagnostic (research §8.1) that measures TTFT + total latency for each router-model candidate against the live proxy, so the final router-client choice is made from measured numbers, not public benchmarks. It is not part of the Vitest suite; only a no-network smoke test guards the candidate list.

**Files:**
- Create: `scripts/router-benchmark.ts`
- Modify: `package.json` (add `bench:router` script)
- Test: `tests/decision-council/routerBenchmark.test.ts`

**Interfaces:**
- Consumes: `COPILOT_PROXY_BASE_URL` / `COPILOT_PROXY_API_KEY` env, `fetch` (Node 24 global).
- Produces:
  - `const ROUTER_BENCHMARK_CANDIDATES: string[]` (model ids)
  - `async function benchmarkCandidate(model: string, env: { baseUrl: string; apiKey: string }): Promise<{ model: string; ttftMs: number; totalMs: number; ok: boolean }>`
  - `async function main(): Promise<void>` (prints a table; invoked when run as a script)

- [ ] **Step 1: Write the failing smoke test**

Create `tests/decision-council/routerBenchmark.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ROUTER_BENCHMARK_CANDIDATES } from "../../scripts/router-benchmark.js";

describe("router benchmark candidates", () => {
  it("includes the research §5 fast-tier candidates", () => {
    expect(ROUTER_BENCHMARK_CANDIDATES).toEqual(
      expect.arrayContaining([
        "claude-haiku-4-5",
        "grok-code-fast-1",
        "gemini-3-flash-preview",
        "raptor-mini",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/decision-council/routerBenchmark.test.ts`
Expected: FAIL — `scripts/router-benchmark.js` not found.

- [ ] **Step 3: Write the benchmark script**

Create `scripts/router-benchmark.ts`:

```ts
// Standalone diagnostic. NOT part of the test suite. Run: npm run bench:router
// Measures time-to-first-token (TTFT) and total latency for each router-model candidate
// against the local Copilot proxy, per research §8.1. Pick the router client from results.

export const ROUTER_BENCHMARK_CANDIDATES: string[] = [
  "claude-haiku-4-5",
  "claude-3-5-haiku",
  "grok-code-fast-1",
  "gemini-3-flash-preview",
  "raptor-mini",
  "gpt-5-mini",
];

const ROUTING_PROMPT =
  'Return JSON {"clientName":"CopilotProxyClaudeHaiku45","model":"claude-haiku-4-5","reasoningEffort":null,"rationale":"fast"} and nothing else.';

export async function benchmarkCandidate(
  model: string,
  env: { baseUrl: string; apiKey: string },
): Promise<{ model: string; ttftMs: number; totalMs: number; ok: boolean }> {
  const start = performance.now();
  let ttftMs = Number.NaN;
  try {
    const response = await fetch(`${env.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: ROUTING_PROMPT }],
      }),
    });

    if (!response.ok || !response.body) {
      return { model, ttftMs: Number.NaN, totalMs: performance.now() - start, ok: false };
    }

    const reader = response.body.getReader();
    let firstChunkSeen = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (!firstChunkSeen && value && value.length > 0) {
        ttftMs = performance.now() - start;
        firstChunkSeen = true;
      }
      if (done) break;
    }
    return { model, ttftMs, totalMs: performance.now() - start, ok: firstChunkSeen };
  } catch {
    return { model, ttftMs: Number.NaN, totalMs: performance.now() - start, ok: false };
  }
}

export async function main(): Promise<void> {
  const baseUrl = process.env.COPILOT_PROXY_BASE_URL;
  const apiKey = process.env.COPILOT_PROXY_API_KEY ?? "anything";
  if (!baseUrl) {
    console.error("Set COPILOT_PROXY_BASE_URL (e.g. http://127.0.0.1:8080/v1) before running.");
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const model of ROUTER_BENCHMARK_CANDIDATES) {
    rows.push(await benchmarkCandidate(model, { baseUrl, apiKey }));
  }

  console.table(
    rows.map((r) => ({
      model: r.model,
      ok: r.ok,
      ttftMs: Number.isNaN(r.ttftMs) ? "-" : Math.round(r.ttftMs),
      totalMs: Math.round(r.totalMs),
    })),
  );
}

// Run main() only when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
```

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, add:

```json
    "bench:router": "tsx scripts/router-benchmark.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/decision-council/routerBenchmark.test.ts`
Expected: PASS (1 test, no network).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0. (`scripts/**` is covered by `tsconfig.json` `include: ["src/**/*.ts", "tests/**/*.ts", ...]` only — if `scripts` is not included, add `"scripts/**/*.ts"` to `include` so the benchmark typechecks.)

- [ ] **Step 7: (Manual, requires live proxy) Run the benchmark and record results**

With the proxy running on `127.0.0.1:8080` and env set per README:

```bash
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
npm run bench:router
```

Expected: a table of `model / ok / ttftMs / totalMs`. Choose the lowest-TTFT non-reasoning candidate as the production router client; if it is not `claude-haiku-4-5`, update `DEFAULT_ROUTING_POLICY` is not needed (router client is set in `baml_src/router.baml`) — instead change the `client` line in `baml_src/router.baml`, re-run `npm run baml-generate`, and commit. Record the measured numbers in `docs/research/2026-06-25-client-model-effort-router.md` (append a "Measured proxy latency" note).

- [ ] **Step 8: Commit**

```bash
git add scripts/router-benchmark.ts package.json tests/decision-council/routerBenchmark.test.ts tsconfig.json
git commit -m "feat(router): add proxy micro-benchmark for router-model selection"
```

---

### Task 9: Documentation and final validation

Update docs and run full project validation; verify the open questions from research §8 are either resolved or explicitly tracked.

**Files:**
- Modify: `README.md`
- Verify: whole project.

- [ ] **Step 1: Document the router in README**

Add a "Model + effort routing" section to `README.md` describing: the hybrid router (policy default + fast LLM for dynamic intent), the default policy table (research §6.1), the sub-5-second guarantee via the `3500` ms abort fallback, that BAML effort passthrough is opt-in pending verification (research §8.2), and how to run `npm run bench:router`. Keep it consistent with the existing env-var docs (`README.md:18-36`).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites pass, including the four new test files.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: `baml-generate` succeeds and `tsc -p tsconfig.json` emits to `dist/` with no errors.

- [ ] **Step 5: Confirm open-question coverage**

Verify each research §8 item is addressed or tracked:
- §8.1 proxy latency → Task 8 benchmark (run manually; results recorded).
- §8.2 BAML `reasoning_effort` passthrough → supported via `toBamlCallOptions`; left out of default policy until the benchmark/manual test confirms the proxy forwards it. If unsupported, BAML effort control stays "swap client only" — note this in README.
- §8.3 `raptor-mini` → included in benchmark candidates; only promote to router client if it shows low TTFT and returns valid JSON.
- §8.4 SDK `listModels()` → **addressed conservatively in Task 7**: persona effort is gated behind an injectable `supportsReasoningEffort(model)` predicate that defaults to `() => false`, so no `reasoningEffort` is sent to the SDK unless an operator explicitly wires capability detection. Live `client.listModels()` verification is intentionally deferred to a follow-on (no network call added by default); the safe default means the deferral cannot cause a runtime error.
- §8.5 build precondition → enforced by Task 0.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(router): document model + effort routing and benchmark usage"
```

- [ ] **Step 7: Report blocking issues (if any)**

If validation surfaces issues beyond minor fixes (e.g. the proxy lacks `claude-sonnet-4-6`, or `reasoning_effort` is dropped), document them and recommend follow-on planning rather than large inline changes:
- Adjust `DEFAULT_ROUTING_POLICY` client names to models the proxy actually serves (informed by `listModels()` / benchmark).
- Decide whether to enable BAML effort passthrough or keep client-swap-only.
- Decide whether to bump the persona default from `claude-sonnet-4.5` after `listModels()` verification.

---

## Self-Review Notes (for the planner; not execution steps)

- **Spec coverage vs research §9:** §9.1 `modelRouter.ts` → Tasks 1, 3, 4. §9.2 `router.baml` → Task 2. §9.3 thread BAML → Task 6. §9.4 thread persona/runner → Task 7. §9.5 benchmark + unit tests → Task 8 + tests throughout. §9.6 green-build precondition → Task 0.
- **Type consistency:** `RoutingDecision`, `RouteRequest`, `RouteTaskKind`, `ModelRouter`, `ReasoningEffort` are defined once in Task 1 and reused unchanged in Tasks 3–7. `toBamlCallOptions` (Task 5) is consumed in Task 6. `defaultRouteModelCall`/`createDefaultModelRouter` (Tasks 3–4, 7) feed the runner.
- **Back-compat:** Adapters and persona worker default to no override; existing tests inject fake deps and remain green.
- **Effort safety (validator High 2 / research §8.4):** persona `reasoningEffort` is only forwarded when an injected `supportsReasoningEffort(model)` predicate returns true; the default predicate is `() => false`, so the SDK never receives an effort field it might reject until capability detection is explicitly wired. `listModels()`-based validation is a tracked follow-on, not a blocker.
- **LLM-route validation (validator High 1):** `LlmModelRouter.route` runs `isValidDecision` against the candidate set and falls back to the policy decision when the model returns a client/model outside the allowed candidates, so a hallucinated route can never reach the proxy.
- **Risk:** default policy assumes `CopilotProxyClaudeSonnet46`/`CopilotProxyClaudeHaiku45` are served by the proxy; Task 9 Step 5/7 handle mismatch. The persona default is intentionally unchanged (`claude-sonnet-4.5`) to avoid silent behavior change.
