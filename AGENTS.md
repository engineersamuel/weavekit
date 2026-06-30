# Repository Instructions

Use Nub for Node.js package and script management in this repository.

- Run files and scripts with `nub <file>`.
- Run scripts with `nub run <script>` instead of `npm run`.
- Use `nubx` instead of `npx` or `pnpm dlx`.
- Use `nub install` instead of `npm install` or `pnpm install`.
- Use `nub watch` instead of `nodemon`, `node --watch`, or `tsx watch`.
- Use `nub node` instead of `nvm`, `fnm`, `n`, or `volta`.
- Use `nub pm` instead of `corepack`.

Nub is preferred because it provides one tool for running files and scripts, installing dependencies, and managing Node itself without adding a new runtime or vendor-specific API surface.

When working with baml read ./docs/baml/instructions.md

Prefer BAML-generated types over creating new hand-authored TypeScript types when the output shape is already defined in a BAML schema. Reuse generated types as the canonical contract and only add new local types when they represent workflow-specific state or input that is not produced by BAML.

If calling the Copilot SDK directly and you want the response to conform to a BAML output schema, append the `ctx.output_format` block to the end of the prompt. This is required because the SDK path does not automatically render BAML's `ctx.output_format` for you.

## Modern TypeScript

Write canonical, erasable TypeScript and avoid arcane runtime hacks. Node 22.18+/24 strips types and runs `.ts` files directly, so source stays build-free; `tsc` is for type-checking only (it does not run the code).

- **Run TS directly, type-check separately.** Execute with `nub <file>.ts` (or `nub run <script>`); never add a transpile step for plain scripts. Keep type errors honest with a `typecheck` script (`tsc --noEmit`) in dev/CI — stripping does **not** type-check.
- **Keep syntax erasable.** No `enum`, `namespace` with runtime code, parameter properties, or `import =`/`export =`. Use `const` objects/unions instead of `enum`, and explicit fields instead of parameter properties, so files run unchanged under native type-stripping. (`erasableSyntaxOnly` in `tsconfig.json` enforces this.)
- **`import type` for types** (`verbatimModuleSyntax`). Type-only imports must use `import type`/`type`; otherwise the runtime treats them as value imports and crashes.
- **Prefer library auto-resolution over hand-rolled paths.** If an SDK/tool resolves something for you, let it. Don't reach for `require.resolve(...)` path tricks unless auto-resolution genuinely fails — and gate that behind an env override.
- **Derive types from public exports.** When a type isn't re-exported, derive it (`Parameters<>`, `ReturnType<>`, `NonNullable<T[k]>`) instead of importing from deep `dist/` paths.

```ts
// ❌ arcane: hand-resolve the runtime path
connection: RuntimeConnection.forStdio({ path: require.resolve("@github/copilot/npm-loader.js") })

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
    "strict": true
  }
}
```

## Workflow instrumentation

- When writing new workflows, consider Langfuse/OpenTelemetry observability from the start: spans, trace metadata, and useful workflow inputs/outputs should be part of the design.
- Do not add a durable work queue (e.g. Beads) for workflow orchestration. Workflows are isolated single-machine runs that complete all work in-process; orchestrate dynamic action graphs in-process, record the execution DAG in Langfuse, and snapshot run state to disk for resume. See `CONTEXT.md` and `docs/adr/0001-no-durable-work-queue.md`.

## Model proxy

By default models are hosted through the copilot-proxy-rs available at http://127.0.0.1:8080 with endpoints  `/health`, `/version`, `/v1/models`, and `/v1/messages/count_tokens` routes.

## TypeScript conventions

- In TypeScript, prefer string enums over raw string literals for fixed key sets such as route names, task kinds, or persona-set identifiers.

An example call

```
curl -fsS http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Say Hello World!"}]}'
```

Add `"stream": true` to the payload if streaming

## Baton workspace spawning

When asked to spawn a Copilot session in a new Baton workspace, use an existing initialized workspace directory as the `cwd` for `baton-spawn_agent_in_new_workspace`. Do not pass the Baton project name or repository path as `cwd`; the MCP resolver expects a workspace path such as `/Users/smendenhall/.baton/worktrees/weavekit/<workspace-name>`.

For this repository, the target project is usually `weavekit`. If spawning for another project, first find or ask the user to open an initialized workspace under `/Users/smendenhall/.baton/worktrees/<project-name>/...`, then pass that exact workspace directory to the Baton MCP tool along with the desired branch name and prompt.
