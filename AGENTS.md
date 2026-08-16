# Repository Instructions

## What weavekit is

weavekit is a **meta harness** — an orchestration layer that sits on top of existing LLM harnesses. It is **not** intended to replace tools like Copilot CLI, Claude Code, or Codex CLI. Those harnesses are purpose-built for LLM-driven coding and agent execution; weavekit defers to them for that work.

**Design principle:** Leverage existing harnesses and SDKs for what they are good at (code generation, agent execution, tool-calling, context management). weavekit owns the **workflow and orchestration layer**: sequencing steps, routing between agents, managing state across runs, and coordinating multi-agent pipelines.

**weavekit does not solve problems that LLMs can solve.** If a step in a workflow requires reasoning, code generation, summarization, classification, or any other LLM-native capability, delegate it to the LLM or harness — do not implement it in weavekit workflow code. weavekit's job is to orchestrate, not to be the intelligence.

When building workflows:

- Use Copilot SDK, Claude Code, Codex CLI, or other harnesses as execution engines for agent tasks.
- Use **BAML** to define structured output schemas and context contracts between workflow steps. BAML is the boundary layer between weavekit orchestration and LLM execution — use it to declare what you expect back, not to implement the logic yourself.
- Let the LLM solve what the LLM is good at. Let the harness manage agent execution, tool-calling, and context. weavekit connects and sequences those pieces.
- Use weavekit to define the workflow graph, manage inter-step data flow, and handle observability (Langfuse traces).
- Do not re-implement capabilities that existing harnesses or LLMs already provide well.

Use Nub for Node.js package and script management in this repository.

- Run files and scripts with `nub <file>`.
- Run scripts with `nub run <script>` instead of `npm run`.
- Use `nubx` instead of `npx` or `pnpm dlx`.
- Use `nub install` instead of `npm install` or `pnpm install`.
- Use `nub watch` instead of `nodemon`, `node --watch`, or `tsx watch`.
- Use `nub node` instead of `nvm`, `fnm`, `n`, or `volta`.
- Use `nub pm` instead of `corepack`.

Nub is preferred because it provides one tool for running files and scripts, installing dependencies, and managing Node itself without adding a new runtime or vendor-specific API surface.

## What RLM is

RLM is a recursive language meta harness and useful when weavekit needs application-owned controls: per-hop profiles and models, skill and tool boundaries, recursive decomposition, enforced depth and breadth budgets, the root-grounded  ask_user  bridge, structured results, and a visible Langfuse recursion tree. If ordinary Copilot subagents already provide the needed fan-out, permissions, and observability, they are simpler and should be used instead. Depth greater than one should be an available capability, not a goal.

## Modern TypeScript

Write canonical, erasable TypeScript and avoid arcane runtime hacks. Node 22.18+/24 strips types and runs `.ts` files directly, so source stays build-free; `tsc` is for type-checking only (it does not run the code).

- **Run TS directly, type-check separately.** Execute with `nub <file>.ts` (or `nub run <script>`); never add a transpile step for plain scripts. Keep type errors honest with a `typecheck` script (`tsc --noEmit`) in dev/CI — stripping does **not** type-check.
- **Always use oxlint for linting and oxfmt for formatting.** Run `nub run lint` (`oxlint --deny-warnings .`) and `nub run fmt` (`oxfmt`) before committing; do not introduce ESLint, Prettier, Biome, or other lint/format tools. `mise run pre-commit` auto-fixes and formats staged files with oxlint/oxfmt (install the hook once per clone with `mise generate git-pre-commit --write`). Generated code under `src/generated/**` is excluded from oxfmt via `.oxfmtrc.json` — it's owned by `baml-cli generate`'s own formatter, so run `nub run baml-generate` to keep it in sync instead.
- **Keep syntax erasable.** No `enum`, `namespace` with runtime code, parameter properties, or `import =`/`export =`. Use `const` objects/unions instead of `enum`, and explicit fields instead of parameter properties, so files run unchanged under native type-stripping. (`erasableSyntaxOnly` in `tsconfig.json` enforces this.)
- **`import type` for types** (`verbatimModuleSyntax`). Type-only imports must use `import type`/`type`; otherwise the runtime treats them as value imports and crashes.
- **Prefer library auto-resolution over hand-rolled paths.** If an SDK/tool resolves something for you, let it. Don't reach for `require.resolve(...)` path tricks unless auto-resolution genuinely fails — and gate that behind an env override.
- **Derive types from public exports.** When a type isn't re-exported, derive it (`Parameters<>`, `ReturnType<>`, `NonNullable<T[k]>`) instead of importing from deep `dist/` paths.

```ts
// ❌ arcane: hand-resolve the runtime path
connection: RuntimeConnection.forStdio({
  path: require.resolve("@github/copilot/npm-loader.js"),
});

// ✅ canonical: let the SDK auto-resolve its bundled runtime; override only via env
const cliPath = process.env.COPILOT_CLI_PATH;
const client = new CopilotClient({
  ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
});
```

```ts
// ✅ derive non-exported types from what the package does export
import type { SessionConfig } from "@github/copilot-sdk";
type SessionHooks = NonNullable<SessionConfig["hooks"]>;
type PreToolUseHandler = NonNullable<SessionHooks["onPreToolUse"]>;
type PreToolUseInput = Parameters<PreToolUseHandler>[0];
```

```jsonc
// tsconfig.json — settings for native-TS execution (type-check only)
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "esnext",
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "noEmit": true,
    "strict": true,
  },
}
```

## Model proxy

By default models are hosted through the copilot-proxy-rs available at http://127.0.0.1:8080 with endpoints `/health`, `/version`, `/v1/models`, and `/v1/messages/count_tokens` routes.

## TypeScript conventions

- In TypeScript, prefer string enums over raw string literals for fixed key sets such as route names, task kinds, or persona-set identifiers.

An example call

```
curl -fsS http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Say Hello World!"}]}'
```

Add `"stream": true` to the payload if streaming
