# Agent Harness Prototype

A compact TypeScript prototype of the capability patterns in Microsoft's
[Agent Harness - Scaling the Claw (or harness capabilities)](https://devblogs.microsoft.com/agent-framework/agent-harness-scaling-the-claw-or-harness-capabilities/):
progressive skill loading, permission-restricted CodeAct, approval-gated shell access, background
worker fan-out, and an observable execution trace.

## Data flow

1. Discover `skill.json` metadata without reading `SKILL.md` bodies.
2. Load the valuation skill only when portfolio work begins.
3. Send code and JSON input over stdin to a separate Node process. Node's permission model denies
   filesystem, child-process, and worker capabilities; the parent enforces a timeout.
4. Load the headline skill, fan out two deterministic ticker workers concurrently, and aggregate
   their results in input order.
5. Ask an approval gate before a confined shell command writes the report under a temporary
   workspace.
6. Return the result and chronological trace.

## Capability map

| Blog capability    | Prototype                                                              |
| ------------------ | ---------------------------------------------------------------------- |
| Progressive skills | `catalog.ts` discovers descriptors, then lazily reads `SKILL.md`       |
| CodeAct            | `codeact.ts` runs dynamic JavaScript in a permission-restricted child  |
| Confined shell     | `shell.ts` validates scope and requests approval before `spawn`        |
| Background agents  | `background.ts` starts workers concurrently and preserves result order |
| Observability      | `trace.ts` records capability lifecycle events                         |
| Harness            | `harness.ts` composes the capabilities into one portfolio scenario     |

## Run

From the repository root:

```sh
nub run prototype:agent-harness
nub run test -- tests/agent-harness-poc
nub run typecheck
```

The CLI prints the loaded skills, computed portfolio metrics, per-ticker headlines, approved report
path, and chronological capability trace.

## Security model

- CodeAct fails closed unless Node exposes its permission API and filesystem read/write, child
  process, and worker permissions are disabled. The child receives an empty environment and no
  filesystem allowlist. The parent kills work that exceeds its deadline.
- Node's permission model does not restrict every resource, including network access. This is a
  focused demonstration, not a production sandbox for arbitrary hostile code.
- The shell uses argument-array spawning without shell interpolation, confines `cwd`, rejects
  obvious dangerous inputs, and requests approval for every command. As the article stresses,
  **the shell policy is a UX guardrail, not a security boundary**.

Production use would require a hardened OS or remote sandbox, resource limits, network isolation,
skill provenance controls, and durable telemetry.
