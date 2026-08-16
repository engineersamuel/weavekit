# RLM d0 capability handoff — keep the write ban, drop the read ban

Date: 2026-08-14
Status: proposed, not implemented
Owner: RLM-POC (`src/rlm-poc/`)
Related: [ADR 0010](docs/adr/0010-recursive-llm-tool-rlm.md), `RLM_HEADLESS_DELEGATION_HANDOFF.md`

---

## 1. Decision

Give the d0 root Submind **read-only** repository tools. Keep the ban on repository
writes. Change one prompt rule to match.

In one line: **d0 must be able to check a worker's claim without spending a delegation.**

---

## 2. Current state

### 2.1 Capability manifest

`src/rlm-poc/profiles.ts:113-118`

```ts
export const RLM_ROOT_CAPABILITY_MANIFEST = {
  authority: "routing-synthesis",
  repositoryWritePermission: false,
  allowedSkillNames: [],
  availableTools: ["custom:rlm", "mcp:*"],
} as const;
```

`src/rlm-poc/profiles.ts:120-125`

```ts
export function createRlmRootAvailableTools(trellageEnabled: boolean): string[] {
  return [
    ...RLM_ROOT_CAPABILITY_MANIFEST.availableTools,
    ...(trellageEnabled ? ["custom:invoke_trellage"] : []),
  ];
}
```

So d0 has exactly three things: the `rlm` tool, MCP servers, and (sometimes)
`invoke_trellage`. It has no file access at all.

### 2.2 Prompt rule

`src/rlm-poc/submindPrompt.ts`, rule 4:

> Delegate only when separation provides meaningful specialization, parallelism, or
> context isolation. Delegate even trivial execution work; d0 may only route,
> reconcile, and synthesize.

### 2.3 ADR text

`docs/adr/0010-recursive-llm-tool-rlm.md`:

> The root Submind is the application orchestrator, not a selectable profile. It is
> routing and synthesis only: its tools are `rlm`, optional `invoke_trellage`,
> discovered MCP, and no root-local skills. It does not directly implement, research,
> design, or review.

### 2.4 Model

`DEFAULT_RLM_PROFILE_MODEL = "mai-code-1.1-flash"` in `src/rlm-poc/profiles.ts`.

**Verify this before you start.** The operator reports d0 is now `gpt-5.6-sol` at
medium effort. The constant may be stale, or the model may be set elsewhere. The
whole argument below depends on which model d0 runs.

---

## 3. Analysis

### 3.1 Why the rule was written

The rule was written when d0 was `mai-code-1.1-flash`. That model is a small,
fast router. You cannot trust it to implement. Forcing every unit of work
through a delegation was the correct guard for that model.

**That reason is gone.** `gpt-5.6-sol` at medium effort can implement.

### 3.2 Why part of the rule must survive

One reason for the rule does **not** depend on the model.

d0 is the synthesizer. Its context is the only place where the whole run comes
together. If d0 reads large files and runs commands, raw output fills that
context. Then the synthesis gets worse.

This is context economics. It is true for every model. So the ban must not be
lifted completely.

The split is:

| Action                                 | Context cost                         | Value to d0             | Verdict                  |
| -------------------------------------- | ------------------------------------ | ----------------------- | ------------------------ |
| Targeted read of a named file or range | low                                  | high — verifies a claim | **allow**                |
| File-name search (glob)                | very low                             | high — locates evidence | **allow**                |
| Broad read of a directory              | high                                 | low                     | discourage in the prompt |
| Shell command                          | unbounded, and can write             | low                     | **deny**                 |
| Repository write                       | permanent, and skips the skill packs | low                     | **deny**                 |

### 3.3 The defect the current rule creates

d0 today cannot check a worker's claim. When a worker returns
`RlmWorkerReport` saying "done, tests pass", d0 has two options:

1. Believe the typed report.
2. Spend one of 12 budget calls on a `review` worker.

Option 1 is faith. Option 2 spends a full session to run the equivalent of
`grep`.

BAML validates the report's **shape**. It does not validate the report's
**truth**. Nothing in the current design closes that gap cheaply.

### 3.4 Measured cost of a delegation

Measured on this machine, 2026-08-14, via `cldx` (Claude Opus 5):

```
Prompt:  "Reply with exactly: A"
Output:  3 tokens
Cost:    $0.279
Time:    2.2 s of API time
Cache creation: 43,667 tokens   <- the system prompt and skill load
```

That is the floor price of one delegated turn on the Trellage path, before any
real work happens. The `rlm` path has its own floor. It is lower, but it is not
zero: every `rlm` call creates a new `CopilotClient`, a new session, and a fresh
system message.

A delegation is never cheap enough to spend on reading one file.

### 3.5 What this does not change

This does **not** make d0 an implementer. Three guards stay:

1. `repositoryWritePermission: false` — d0 writes nothing.
2. `allowedSkillNames: []` — d0 has no skill packs. All the specialised
   capability stays in the profiles.
3. No `bash` — d0 runs no commands. `bash` is a write vector and its output is
   unbounded.

d0 gains exactly one new power: it can look at the repository to confirm or
reject what a worker told it.

---

## 4. Changes to make

### 4.1 Tool names

The repo's own vocabulary is in `src/rlm-poc/profiles.ts:27-38`:

```ts
const SCOPED_RECURSIVE_TOOLS = ["builtin:ask_user", "custom:rlm", "skill"];
const SCOPED_INVESTIGATION_TOOLS = [
  "builtin:ask_user",
  "custom:rlm",
  "skill",
  "bash",
  "view",
  "glob",
  "web_search",
  "web_fetch",
  "mcp:*",
];
```

`view` reads. `glob` finds files by pattern. Both are read-only. Use those two.

Do **not** add `bash` (writes, unbounded output), `web_search` or `web_fetch`
(that is a worker's job, and it floods d0's context).

> **Open item:** the Copilot SDK ships a `grep` tool name (found in
> `node_modules/@github/copilot-sdk/dist/*.d.ts`). This repo does not use it
> anywhere. Content search would help d0 verify claims. Confirm the tool exists
> and is read-only, then decide whether to add it. Do not add it unverified.

### 4.2 `src/rlm-poc/profiles.ts`

```ts
export const RLM_ROOT_CAPABILITY_MANIFEST = {
  authority: "routing-synthesis-verification", // was "routing-synthesis"
  repositoryWritePermission: false, // UNCHANGED — the write ban
  allowedSkillNames: [], // UNCHANGED — no skill packs
  availableTools: ["custom:rlm", "mcp:*", "view", "glob"], // added: view, glob
} as const;
```

### 4.3 `src/rlm-poc/submindPrompt.ts`

Replace rule 4:

```diff
- Delegate only when separation provides meaningful specialization, parallelism, or
- context isolation. Delegate even trivial execution work; d0 may only route,
- reconcile, and synthesize.
+ Delegate all writes, and all work that needs a profile skill pack, parallelism, or
+ context isolation. You may read the repository yourself with `view` and `glob` to
+ verify what a worker reported. Keep those reads targeted: name the file and the
+ line range. Do not read broadly. Your context is the synthesis, and raw file
+ content degrades it.
```

The last two sentences are load-bearing. Without them you trade a call-budget
problem for a context problem.

### 4.4 Add a verification instruction

The new tools are useless unless d0 is told when to use them. Add to
`submindPrompt.ts`, near the result-handling guidance:

> When a worker reports that it changed a file, ran a test, or produced an
> artefact, confirm the claim before you accept it. Use `view` on the exact file
> the worker named. One targeted read is far cheaper than a `review` delegation.
> Escalate to a `review` worker only when the check needs judgement, not when it
> needs eyes.

### 4.5 `docs/adr/0010-recursive-llm-tool-rlm.md`

Amend the root-Submind paragraph:

```diff
- It is routing and synthesis only: its tools are `rlm`, optional `invoke_trellage`,
- discovered MCP, and no root-local skills.
+ It is routing, synthesis, and verification: its tools are `rlm`, optional
+ `invoke_trellage`, discovered MCP, read-only `view`/`glob`, and no root-local
+ skills. It reads to verify a worker's report. It never writes, runs shell
+ commands, or loads a skill pack.
```

Leave the following sentence as it is — it is still true:

> It does not directly implement, research, design, or review.

---

## 5. Risks

| Risk                                                                    | Likelihood | Mitigation                                                                                                                   |
| ----------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| d0 reads broadly and pollutes its own synthesis context                 | medium     | The explicit "targeted reads only" prompt rule. Watch the d0 token count on the Langfuse `SUBMIND d0` span before and after. |
| d0 stops delegating and tries to do the work by reading                 | low        | It has no write tool and no shell. It physically cannot implement. Worst case it reads a lot and still has to delegate.      |
| `view`/`glob` are not the correct SDK tool names for the root session   | low        | They are already used by four shipped profiles in this repo. Confirm in one smoke run.                                       |
| Skill-boundary check rejects the new tool names                         | low        | The boundary check covers **skills**, not tools. `allowedSkillNames` stays `[]`. No change there.                            |
| A stale `DEFAULT_RLM_PROFILE_MODEL` means d0 still runs the small model | **medium** | Verify section 2.4 first. If d0 still runs `mai-code-1.1-flash`, do not make this change.                                    |

---

## 6. Test plan

### 6.1 Unit

- `RLM_ROOT_CAPABILITY_MANIFEST.repositoryWritePermission` is still `false`.
- `RLM_ROOT_CAPABILITY_MANIFEST.allowedSkillNames` is still `[]`.
- `createRlmRootAvailableTools(false)` returns `view` and `glob`, and does **not**
  return `bash`, `write`, `create`, `str_replace_editor`, `shell`, `web_search`,
  or `web_fetch`.
- `createRlmRootAvailableTools(true)` adds `custom:invoke_trellage` and nothing
  else.

### 6.2 Prompt

- The rendered d0 prompt contains the new verification instruction.
- The rendered d0 prompt no longer contains "Delegate even trivial execution work".

### 6.3 Integration — the acceptance test

Run one general Submind turn against a small real task. Assert all four:

1. d0 delegates the implementation. It does not attempt it.
2. d0 calls `view` at least once on a file the worker named.
3. The run uses **fewer** budget calls than the same task before the change.
4. The final answer cites the verified file content, not only the worker's report.

### 6.4 Negative test

Give d0 a task that can only be finished by writing a file. Assert that d0
delegates it, and that no write reaches the repository from the d0 session.

### 6.5 Regression

- Full suite green.
- Known pre-existing failure: `tests/rlm-poc/runtime.test.ts:338` asserts
  `model: "gemini-3.6-flash"` while the live catalog now serves
  `gemini-3.7-flash`. This is a test coupled to a rotating catalog, not a logic
  defect. Unrelated to this change. Baseline is **219 of 220 passing**.

---

## 7. Acceptance criteria

- [ ] d0's model confirmed as `gpt-5.6-sol` medium, not `mai-code-1.1-flash`.
- [ ] `repositoryWritePermission` is still `false`.
- [ ] `allowedSkillNames` is still `[]`.
- [ ] `view` and `glob` added. `bash` not added.
- [ ] Rule 4 replaced. Verification instruction added.
- [ ] ADR 0010 amended.
- [ ] Integration test in 6.3 passes all four assertions.
- [ ] Negative test in 6.4 passes.
- [ ] Suite at or above the 219/220 baseline.

---

## 8. Open questions

1. Does the Copilot SDK expose a read-only content-search (`grep`) tool? If yes,
   add it — verification is much weaker without content search.
2. Should d0's read tools be capped, for example by a maximum number of `view`
   calls per turn? Start without a cap. Add one only if the Langfuse token counts
   show real context growth.
3. Does the `review` profile still earn its place once d0 can read? It should —
   `review` is for judgement, d0's reads are for facts. Re-check after one week
   of real runs.
