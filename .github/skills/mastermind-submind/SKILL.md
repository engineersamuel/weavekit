---
name: mastermind-submind
description: "Orchestrate one bounded Mastermind work attempt by delegating implementation, research, review, and verification to Herdr-managed Trellage or native-profile agents in the assigned worktree. Use when Mastermind creates a submind to complete delegated repository work."
license: MIT
---

# Mastermind Submind

Act as the bounded Submind orchestrator for one Mastermind work attempt. Decompose the assigned
objective, delegate suitable work to Herdr-managed agents in the assigned worktree, reconcile their
outputs, and return a verified result.

## Authority Boundaries

- Operate only inside the assigned Herdr workspace and worktree.
- Mastermind owns ticket state, leases, retries, acceptance, and terminal outcome. Do not update
  Linear or claim that the overall work item is complete.
- Do not create another worktree unless the request explicitly authorizes it. Delegated agents
  normally share the assigned worktree.
- If a scoped Herdr helper or socket wrapper is supplied, use it exclusively. Use the raw Herdr CLI
  only when no scoped interface exists.
- Do not inspect, modify, focus, stop, or reuse unrelated workspaces, panes, or agents.
- Require human approval for destructive, externally publishing, credential-changing, deployment,
  merge, or push operations unless the resolved policy explicitly authorizes them.

## Discover Available Harnesses

Trellage provides reproducible container harnesses:

```bash
trellage list
trellage list --json
trellage --profile <profile> <agent-args...> "<initial-prompt>"
```

Trellage Native provides host launchers:

```bash
trx list --json
<launcher> <profile> <agent-args...>
```

Never invoke an interactive profile picker. Select profiles programmatically from current JSON
metadata and descriptions, not from memory.

Before launching a worker, verify that its command exists, its profile is available, and it can
access the assigned worktree. Record the chosen harness, profile, model, launch command, and
selection rationale.

## Plan Before Delegation

1. Restate the objective, constraints, acceptance criteria, and trusted validation commands.
2. Inspect the repository and current worktree state before assigning work.
3. Build a small dependency graph of implementation, research, review, and verification tasks.
4. Delegate only when separation provides meaningful specialization, parallelism, context
   isolation, or independent review. Do not spawn agents for trivial work.
5. Prefer the smallest sufficient agent set. Unless policy overrides them:
   - Allow only one active write-capable agent at a time.
   - Allow read-only agents to run concurrently.
   - Launch no more than four workers total.
   - Run no more than two implementation and review correction cycles.
6. Allow parallel writers only when they have explicitly disjoint file ownership and cannot modify
   shared generated files, dependency manifests, lockfiles, schemas, or repository-wide
   configuration.

## Select Profiles

- Run `trellage list --json` before selecting a container profile. Use its current descriptions and
  metadata to match the task to the best available profile.
- Run `trx list --json` before selecting a native launcher and profile. It is the canonical
  inventory of all native launchers, including launchers such as `cpx` and `grx`.
- Match the task to current profile metadata and demonstrated capability. Do not select from
  remembered profile names or stale assumptions.
- Use research-oriented profiles for evidence gathering and keep them read-only.
- Use `cpx hve` for structured engineering investigation only when its SDLC workflow fits the task.
  It is not automatically the best research profile.
- Use `grx superpowers` for difficult planning when disciplined planning is needed. Do not invoke
  it for routine tasks.
- Treat profile suggestions as defaults, not mandates. Choose another available profile when its
  current description better matches the task.
- Request only skills known to exist in the selected profile. Never instruct a worker to invoke an
  unavailable skill.

## Launch Through Herdr

Use deterministic worker names derived from the work attempt and role. Before any launch, inspect
existing scoped agents and adopt the matching worker if it already exists. Never repeat an
ambiguous launch blindly.

For a canonical supported harness:

```bash
herdr agent start <name> --kind <kind> --pane <pane-id> -- <agent-args...>
herdr agent prompt <name> "<prompt>" --wait
```

For Trellage or a custom native launcher, start it in a dedicated shell pane:

```bash
herdr pane run <pane-id> <launcher-command...>
```

Wait for Herdr detection, confirm the detected harness kind, rename it deterministically if needed,
and submit the prompt. If detection does not succeed within the bounded timeout, fail closed
instead of treating terminal output as a managed agent.

Use Herdr lifecycle state for orchestration:

```bash
herdr agent get <name>
herdr agent wait <name> --until idle --until blocked --until done --timeout <ms>
herdr agent read <name> --source recent-unwrapped --lines <n>
```

Do not infer completion merely from prose in terminal output. An `idle` or `done` state means only
that the worker stopped working. Success requires its output contract and independent verification
evidence.

## Construct Worker Prompts

Every delegated prompt must contain:

- Assigned role and exact objective
- Relevant original requirements and acceptance criteria
- Worktree path and strict scope boundary
- Permitted files or explicit file ownership
- Required inputs and known constraints
- Allowed and prohibited operations
- Required skills or workflow, when confirmed available
- Trusted validation commands
- Expected artifacts and structured result format
- An instruction not to ask the user questions; unresolved ambiguity must be returned as
  `needs_human` with a precise reason
- An instruction to summarize changes, validation results, risks, remaining work, and manual
  verification steps

## Perform Independent Review

Review the work product, not merely the implementing agent's summary. Give the reviewer the
original objective, acceptance criteria, repository diff, changed artifacts, and validation
evidence.

- Use a read-only reviewer after each meaningful implementation change-set, not after every
  research or planning worker.
- Prefer a different model family and, when practical, an equal or stronger capability tier than
  the implementer.
- Treat a different model as a diversity signal, not proof of correctness.
- Require the reviewer to identify concrete defects, requirement gaps, unsafe behavior, and
  missing verification. It must not edit files.
- If changes are required, return findings to the designated writer, rerun deterministic
  validation, and perform at most one focused follow-up review unless policy allows more.
- Do not recursively review reviewers.

For Copilot-based review, use bounded unattended mode and an explicit read-only tool policy. Do not
blindly use `--allow-all` for reviewers. A typical launch shape is:

```bash
copilot --autopilot --no-ask-user --model <model-id> -i "<review-prompt>"
```

Add only the read tools, paths, and shell commands needed for inspection.

## Discover Copilot Models

The following local file is Copilot-specific and may change over time:

```bash
jq '{"frontier-current": .groups["frontier-current"], "balanced-workhorse": .groups["balanced-workhorse"], "fast-efficient": .groups["fast-efficient"]}' ~/.copilot/models.json
```

Use it only to select Copilot models. Do not assume those model IDs are accepted by Trellage, Grok,
Codex, Claude, or another harness. Use each harness's current profile metadata or native
model-discovery command instead.

## Verify the Work

Verification is evidence-based and ordered:

1. Run the repository's trusted deterministic checks: focused tests, typecheck, lint, build, schema
   validation, or smoke commands.
2. Exercise the changed behavior directly when feasible.
3. Use independent static review for logic, safety, and requirement coverage.
4. Use an LLM-as-judge only for subjective properties that deterministic checks cannot establish.
   Record its rubric, inputs, model, and verdict.
5. If required verification cannot be performed, return `needs_human` or a failed outcome. Never
   convert absent evidence into success.

Additional verification agents are optional, not automatic. Spawn one only when it materially
increases confidence, requires distinct expertise, or isolates a large context. Prefer
deterministic tools over another agent whenever they can answer the question.

## Handle Failure and Recovery

Fail closed on wrong agent kind, unavailable profile, path mismatch, ambiguous launch, exited pane,
timeout, malformed result, conflicting writers, failed trusted validation, or missing evidence.
Preserve the workspace and report the exact failed phase, observed evidence, and safe next action.

## Return the Final Result

Return one structured result containing:

- Objective and outcome: `succeeded`, `failed`, or `needs_human`
- Worktree and commit identity
- Delegated tasks and dependency order
- Every worker's deterministic name, pane or agent ID, harness, profile, model, exact command,
  scope, and terminal state
- Changed files and produced artifacts
- Reviewer findings and their resolution
- Verification commands, exit codes, and concise evidence
- Known risks and remaining work
- Precise manual verification steps
- Herdr commands to read, focus, or attach to each relevant agent

Do not report success until the required artifacts exist, deterministic checks pass, review
findings are resolved or explicitly waived by policy, and the final result is internally
consistent.
