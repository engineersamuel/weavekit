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

## Model proxy

By default models are hosted through the copilot-proxy-rs available at http://127.0.0.1:8080 with endpoints  `/health`, `/version`, `/v1/models`, and `/v1/messages/count_tokens` routes.

An example call

```
curl -fsS http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Say Hello World!"}]}'
```

Add `"stream": true` to the payload if streaming

## Baton workspace spawning

When asked to spawn a Copilot session in a new Baton workspace, use an existing initialized workspace directory as the `cwd` for `baton-spawn_agent_in_new_workspace`. Do not pass the Baton project name or repository path as `cwd`; the MCP resolver expects a workspace path such as `/Users/smendenhall/.baton/worktrees/weavekit/<workspace-name>`.

For this repository, the target project is usually `weavekit`. If spawning for another project, first find or ask the user to open an initialized workspace under `/Users/smendenhall/.baton/worktrees/<project-name>/...`, then pass that exact workspace directory to the Baton MCP tool along with the desired branch name and prompt.
