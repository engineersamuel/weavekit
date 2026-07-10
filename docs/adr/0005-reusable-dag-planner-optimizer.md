# Reusable Template Optimizer

The template optimizer will live as a reusable macro-workflow service rather than being embedded only in the Source-to-project harness, and it will run outside live user Runs. Source-to-project advisory mode is the first template under optimization because its Static template already combines fixed initial evidence-gathering nodes with a Dynamic DAG expansion policy for planning and reporting. The optimizer's responsibility is generic: maintain an Incumbent template, generate Challenger templates, ask an LLM-backed Template judge for structured comparison, and return the best Template candidate for possible adoption into future Runs. The first Incumbent template is always the current deterministic template and expansion policy so optimized planning must beat existing behavior rather than merely choose among novel LLM proposals. The optimizer consumes caller-supplied Workflow grammar constraints instead of hard-coding today's node kinds, harnesses, gates, or transitions.

For v1, the Template judge uses GPT-5.5 by default, and challenger generation defaults to Opus 4.8 with a configurable path to GPT-5.5. Candidate diversity comes from prompt strategy rather than mixing generator models in the same optimization run, so early results remain interpretable.

Candidate generation and judging both use BAML in v1, with schemas and functions isolated in `baml_src/template_optimizer.baml` rather than overloading runtime workflow planning schemas in `workflow_planner.baml`. The optimizer reuses the existing BAML `WorkflowNode` class where possible and defines only optimizer-specific wrapper classes such as Template candidate, expansion case, fixture judgment, aggregate judgment, and adoption task.

The optimizer evaluates candidates against hand-authored fixtures under `evals/template-optimizer/source-to-project/`. Each fixture is judged independently, then aggregated; a challenger may replace the incumbent when aggregate quality improves by at least 0.03 and no fixture reports a critical regression. Rejected challenger critiques are retained as compact rejected-move summaries and fed into later generation.

The optimizer produces both a final recommendation package and a leaderboard of valid candidates, but only the final Incumbent template is considered adoptable. The implementation surface is a shared library under `src/macro-workflow/templateOptimizer/`, a CLI script for interactive runs, and `mise` task wrappers. The workflow is two-stage: `optimize-template` runs live LLM generation/judging and writes an adoption package, while `optimize-template:apply` explicitly applies a selected run's winning Template candidate to the repository.

The apply stage uses an implementation agent or LLM guided by the structured adoption package rather than a brittle deterministic code transform. For v1 it may update the source-to-project template and Dynamic DAG expansion policy, focused tests, and docs, but it must not change BAML contracts or generated BAML types. It applies the final Incumbent template by default, optionally accepts a candidate-id override for experiments, and modifies the current worktree rather than creating branches or commits.

The optimize CLI requires an explicit template id and mode. It defaults to 5 iterations, allows an `--iterations` override with a hard max of 10, defaults to one challenger per iteration, and allows `--candidates-per-iteration` up to 3. Candidate diversity uses internal prompt-strategy rotation by default, with explicit strategy override flags for reproducible runs. The default judge model is GPT-5.5 and the default generator model is Opus 4.8, with CLI model overrides. Judge confidence is recorded and may be enforced with an optional minimum confidence threshold, but it is not replacement-blocking by default.

The optimize CLI also honors the pre-run budget gate from ADR 0006 after fixtures and candidate counts are known and before challenger generation starts. This budget gate is an admission check alongside `mise run doctor` and the iteration/candidate caps; it does not replace those caps, serialize parallel Autonomous PR worktrees, or add a concurrency cap.

The apply CLI supports `--dry-run`, which asks the implementation agent to produce a planned diff summary from the winning adoption package without modifying files.

Optimizer run artifacts persist enough context for audit and best-effort reproduction: template id, git/working-tree summary, CLI options, model ids, strategy order, fixture ids, baseline template snapshot, generated candidates, judge outputs, and the final recommendation. Exact deterministic replay is not promised because live LLM calls are nondeterministic.

ADR 0007's `workflow run --resume` contract applies to live macro-workflow Run snapshots, including
their dynamically expanded current plans. Template Optimizer evaluation artifacts remain a
separate audit/reproduction contract and are not made resumable by this decision.

Once invoked, the apply stage proceeds automatically without a second confirmation prompt unless it detects conflicting worktree changes or broader-scope edits. The optimize stage must run `mise run doctor` before candidate generation so it does not optimize from a broken baseline. Before reporting apply success in v1, the apply stage must run `mise run doctor` again plus focused source-to-project/template optimizer validation.

Each optimizer run starts from the current checked-in template and writes machine-readable output plus a Markdown summary under `evals/template-optimizer/runs/<run-id>/`. During a run, challengers compare against the current Incumbent template; at the end, the final Incumbent is compared back to the checked-in baseline so the net improvement remains clear. Prior optimizer runs are optional explicit context, not implicit memory.

Template candidates are structured proposals, not executable patches. For v1 they may change the initial node structure and explicit Dynamic DAG expansion cases, but they may not change BAML contracts, output schemas, model proxy setup, or runtime prompt implementations. Node prompts are represented as intent summaries plus references to existing prompt builders when applicable, and expansion policy is represented as explicit cases with trigger, condition summary, nodes, expected payloads, ordering requirements, and rationale.

Template candidates represent Source-to-project modes with separate expansion policies. Advisory mode is enabled for optimization first. Autonomous PR mode is represented in the candidate shape with baseline constraints and expansion cases, but it is not enabled for optimization until PR-mode fixtures and safety assertions exist. This preserves a clear safety boundary while keeping the template schema ready for near-term Autonomous PR work.

Source-to-project candidates use a shared initial DAG across modes plus mode-specific expansion policies. Advisory optimization may change the shared initial DAG, but such candidates must flag that future Autonomous PR review is required. That flag is an adoption warning, not a v1 apply blocker.

Autonomous PR policy is represented from the start even when disabled for optimization. Its baseline constraints require the autonomous PR flag to be enabled, every included Opportunity to have confidence of at least 0.95, worktree preparation before writes, final recommendation review before implementation, Verification gates after writes, and no merge or self-approval behavior. When Autonomous PR mode is enabled, the expansion policy may pursue all eligible autonomous PR candidates, not only the top selected candidate. Eligible autonomous PR candidates use parallel autonomous worktrees, and worktree creation is delegated to a project-scoped Worktree creation provider configured in `~/.weavekit/config.toml` rather than hard-coded to `git worktree add`; for example, a project may configure `[projects.weavekit.worktree_provider]` with `kind = "command"`, `command = "herdr"`, and args equivalent to `["worktree", "create", "--cwd", "{projectPath}"]`.

The Worktree creation provider receives template variables such as `{projectPath}`, `{projectId}`, `{candidateId}`, `{runId}`, and `{branchName}`. It reports the created worktree by printing JSON with `worktreePath` preferred, or a plain path as the last non-empty stdout line. Each parallel autonomous worktree maps to one pull request in v1; results are not merged back into a single PR. Autonomous PR worktrees, implementation, verification, and PR creation run fully in parallel with no concurrency cap; the eligibility confidence threshold is the intended throttle.

Parallel autonomous PR candidates are failure-isolated. One candidate's worktree, implementation, verification, or PR failure does not block other eligible candidates from completing. The final run report must represent per-candidate outcomes and may need a partial-success status when some independent PR paths succeed and others fail.

Final recommendation review runs independently per eligible autonomous PR candidate before that candidate's implementation path starts.

Autonomous PR expansion avoids duplicate work between bundles and individual opportunities. Eligible bundles are selected first when they are valid and every included Opportunity meets the confidence threshold; included Opportunity ids are then removed from the individual pool. The workflow spawns one worktree/PR per eligible bundle and one worktree/PR per remaining eligible individual Opportunity.

Candidate adoption guidance is represented as structured adoption tasks with kind, likely files, description, and acceptance checks. Existing file paths are validated when possible while proposed new files are allowed explicitly. Test guidance remains test intent rather than generated test code. Optimizer summaries include deterministic Mermaid diagrams for reviewability.

Template optimization fixtures use compact scenario summaries with optional typed payload snippets. They include ideal features to reward, must-preserve assertions to protect, and failure modes to avoid.

**Considered Options**

- Embed the loop in `sourceToProject/harnesses.ts`, which would be faster for the first use case but would blur source-specific workflow logic with generic template search behavior.
- Put the loop under `src/macro-workflow/`, keeping Source-to-project responsible only for supplying the baseline template, objective context, evaluation scenarios, and workflow-specific constraints.
