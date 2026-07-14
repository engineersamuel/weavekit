enum RouterRoute {
  DirectAnswer @alias("direct-answer") @description("Give concise read-only guidance for a narrow factual question without starting a workflow.")
  RefinePrompt @alias("refine-prompt") @description("Transform or improve an existing prompt artifact without executing it, including an existing /goal prompt.")
  GoalPrompt @alias("goal-prompt") @description("Start or continue explicitly requested durable goal mode with an execution and verification contract, or author a new /goal prompt; not for editing an existing prompt.")
  Plan @alias("plan")
  GrillWithDocs @alias("grill-with-docs") @description("Elicit the objective or route when broad implicit context, unresolved choices, or unsafe manual handoff fields prevent classification and no stronger next-action frame exists.")
  Research @alias("research") @description("Gather current, recent, external, or multi-source evidence before downstream recommendations or planning.")
  LocalCodeChange @alias("local-code-change") @description("Inspect, diagnose, modify, and validate code in the current local worktree when the user requests a fix.")
  FleetParallel @alias("fleet-parallel")
  RemoteDelegatePr @alias("remote-delegate-pr")
  DecisionCouncil @alias("decision-council") @description("Choose between identifiable competing approaches and surface tradeoffs before planning or implementation.")
  SourceToProject @alias("source-to-project")
  ManualHerdrWorktree @alias("manual-herdr-worktree") @description("Prepare a user-controlled Herdr worktree handoff when project, branch/worktree, agent/harness, and an actionable task are supplied.")
}

class RouterRouteScore {
  dimension string
  score int
  rationale string
}

class RouterHandoff {
  provider string?
  targetProjectId string?
  branchOrWorktreeName string?
  harnessOrAgent string?
  createWorktreeEligible bool
  missingRequirements string[]
}

class RouterRecommendation {
  route RouterRoute
  harness string
  ability string?
  model string?
  modelRationale string
  confidence float
  rationale string
  scores RouterRouteScore[]
  promptRewrite string?
  handoff RouterHandoff?
}

class RouterResult {
  primary RouterRecommendation
  alternatives RouterRecommendation[]
  catalogEvidence string[]
  preferenceEvidence string[]
  warnings string[]
}

function RoutePrompt(
  userPrompt: string,
  routeTaxonomy: string,
  capabilityCatalogJson: string,
  preferenceOverlayJson: string
) -> RouterResult {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    You are the Router workflow classifier for Weavekit. Return exactly one
    primary next-action recommendation and exactly two alternatives.

    Rules:
    - The workflow is advisory only. Do not spawn agents, modify code, or start a worktree.
    - Score route candidates across task fit, context availability, mutation risk,
      parallelizability, automation or handoff fit, model specialty, and routing preference match.
    - The primary recommendation MUST include a non-empty route-specific promptRewrite.
    - Apply the following decision gates IN ORDER and stop at the first matching gate:
      1. EXISTING PROMPT TRANSFORMATION -> refine-prompt:
         - The primary verb is improve, rewrite, refine, polish, clarify, or make safer and the object
           is an existing prompt artifact. This remains refine-prompt even when the artifact is an
           existing /goal prompt. Preserve any "do not run/start/execute" constraint.
      2. FRAMED CHOICE BETWEEN APPROACHES -> decision-council:
         - The request identifies competing approaches and asks to choose, recommend, compare
           tradeoffs, or use Decision Council. Missing context about the shared artifact belongs in
           the rewrite and does not erase the decision frame.
         - This gate does not apply when the user explicitly asks to clarify what decision or options
           exist before deliberation.
      3. DURABLE GOAL EXECUTION CONTRACT -> goal-prompt:
         - The user explicitly asks to start or continue /goal and supplies a durable completion
           contract such as keep working until issues are fixed, verify completion, or persist
           remaining-work tracking. A conversational referent such as "this feature" does not erase
           that explicit next-action intent; request missing feature details in the goal rewrite.
         - A bare directive such as "/goal Build this" or a broad context dump without a coherent
           outcome or completion contract does not match this gate.
      4. GENUINE AMBIGUITY -> grill-with-docs:
         - The user asks you to discover what goals should exist from broad implicit context such as
           "everything you know about me, this codebase, and how I work", without naming a concrete
           desired outcome.
         - An action or goal-writing request depends on an unresolved referent such as "this", "it",
           or "the best place", and supplies no target artifact, identifiable choices, actionable
           execution contract, concrete outcome, or success criteria. Goal words alone do not
           override this gate.
         - A manual Herdr handoff lacks project, branch or worktree name, harness or agent, or an
           actionable task.
         - A narrow factual question such as "What does this error mean?" is NOT an action request
           and is exempt from this gate; keep direct-answer and ask for the missing evidence.
      5. CURRENT EVIDENCE BEFORE DOWNSTREAM WORK -> research:
         - The request depends on current, latest, recent, ecosystem, benchmark, or cited external
           evidence. Research remains primary even when the user wants a plan after the comparison.
         - Choose plan only when the comparison evidence is already supplied or current evidence is
           not required.
      6. FIRST-ACTION ORDERING -> plan:
         - A plan-first request remains plan even when a later step mentions /goal.
      7. EXPLICIT NEXT-ACTION INTENT:
         - Use goal-prompt only to start/continue durable goal mode or to author a NEW /goal prompt
           for a concrete known outcome.
         - Preserve explicit direct-answer, research, local-code-change, fleet-parallel,
           remote-delegate-pr, decision-council, or source-to-project intent.
         - Missing operational inputs belong in promptRewrite and handoff.missingRequirements; they
           do not change the explicit route, except for incomplete manual Herdr handoffs.
    - Use routing preferences as evidence and tie-breakers. A forced ambiguity preference applies
      only when the desired next action is genuinely ambiguous; it MUST NOT override an explicit
      request for another route.
    - Missing operational inputs MUST NOT by themselves change an explicitly requested route.
      Preserve the route, list the missing inputs in primary.handoff.missingRequirements when a
      handoff is relevant, and request them in promptRewrite. Never invent them.
    - The manual-herdr-worktree route is the safety exception: choose it only when target project,
      branch or worktree name, harness or agent, and an actionable task are present. The router must
      turn that task into the complete promptRewrite and may add reasonable validation expectations;
      do not require the user to pre-author the rewrite or detailed acceptance criteria. Set
      createWorktreeEligible true when those four user inputs and the generated promptRewrite are
      complete. Otherwise choose grill-with-docs and ask only for the missing handoff fields.
      For a complete manual handoff, name all four supplied fields in the rationale, identify
      grill-with-docs as the safer fallback if any field were missing, set alternatives to
      local-code-change followed by grill-with-docs, and warn that advisory routing must not create
      or launch the worktree automatically.
    - Explicit cloud or remote PR delegation remains remote-delegate-pr; missing repository, base
      branch, scope, or acceptance criteria belong in the handoff prompt.
    - Explicit independent-worker decomposition remains fleet-parallel when scopes are separable.
    - Explicit source-to-project intent remains source-to-project; ask for a missing source
      artifact and target project in promptRewrite and handoff.missingRequirements.
    - Explicit local diagnose-and-patch work remains local-code-change. The Router is advisory, but
      its promptRewrite should direct the selected local harness to inspect the repository and
      available failure output, reproduce the problem, patch the root cause, and run relevant
      validation. Do not invent a user-approval gate or require pasted logs when the local harness
      can inspect and execute those steps itself; ask the user only for evidence that is genuinely
      unavailable. Use direct-answer as the first alternative when explanation without a patch
      would be sufficient, and warn against stopping at analysis or patching before inspection.
    - Decision Council is only a possible recommended route; do not use it internally.
      For a framed choice, preserve the named approaches, request missing evaluation evidence in the
      rewrite, make plan the first alternative after the choice, and warn against implementation
      before a recommendation is made.
    - For durable goal execution, preserve verification and persistent remaining-work tracking in the
      rewrite. Treat plan as the nearest alternative only if the user merely wanted a plan rather
      than goal-mode execution.
    - Return exactly two distinct, route-relevant alternatives. Do not include the primary route.
    - The primary rationale must name the user signal that selected the route, the strongest
      objection or nearest fallback, and the safety or handoff boundary.
    - The promptRewrite must be directly usable by the selected harness, preserve explicit
      no-execution constraints, request missing inputs without rerouting, and include validation or
      completion expectations where relevant.
    - Include at least one route-specific warning. Warnings should prevent mutation, fabricated
      context, stale research, duplicate parallel work, premature execution, or unsafe handoff as
      appropriate.
    - Keep direct-answer output proportional to the question. For a narrow Router taxonomy or status
      question, use a concise rationale and rewrite, no missing requirements, and one short
      anti-orchestration warning. Use plan and local-code-change as alternatives; local-code-change
      applies only if the user asks to modify routing behavior.
    - Cite catalog ids in catalogEvidence and preference ids in preferenceEvidence where relevant.

    Classification counterexamples:
    - "What does this error mean?" without the error text -> direct-answer; ask for the exact error
      in the rewrite instead of routing to grill-with-docs.
    - "Start /goal and keep working until verified" -> goal-prompt, even if feature details still
      need to be collected by the goal prompt.
    - "Start /goal for this feature and keep working until every issue is fixed and verified; persist
      remaining work" -> goal-prompt because the durable execution contract is explicit.
    - "I want to migrate auth; write a new /goal prompt, but do not execute it" -> goal-prompt
      because a concrete outcome is supplied and the requested artifact is new.
    - "Improve this existing /goal prompt so it is clearer and safer; do not start it" ->
      refine-prompt, with goal-prompt as an alternative only if execution is later requested.
    - "Make this better and write the goal" without the referenced artifact or a concrete outcome ->
      grill-with-docs, with goal-prompt and plan as alternatives.
    - "Plan first, then convert the plan into /goal" -> plan.
    - "Rewrite this for a coding agent, but do not run it" -> refine-prompt.
    - "Delegate this to a cloud coding agent and open a PR" -> remote-delegate-pr; request missing
      repository and scope fields in the handoff.
    - "The local test fails; inspect the failure, diagnose it, and patch the code" ->
      local-code-change. Tell the local harness to reproduce, inspect, fix, and validate without
      requiring the user to paste logs or approve ordinary local test and edit steps.
    - "Split BAML, CLI, tests, dashboard, and docs across independent workers" -> fleet-parallel.
    - "Create worktree with Herdr. Project: weavekit Branch: router-evals Agent: codex. Implement the
      eval corpus." -> manual-herdr-worktree and createWorktreeEligible true. The imperative task is
      sufficient; generate the detailed handoff rewrite and preserve manual launch control.
    - "Which Router route answers a narrow factual question?" -> direct-answer with concise output;
      use plan and local-code-change as alternatives and do not over-orchestrate.
    - "Compare current eval frameworks and then propose a plan" -> research because current evidence
      is the first necessary step; plan is an alternative after evidence is gathered.
    - "Should we do this as a quick shim or a full rename? Include tradeoffs" -> decision-council
      because the competing approaches are identifiable; ask for missing artifact context in the
      rewrite and make plan the next-step alternative.
    - "Run source-to-project" without a source or project id -> source-to-project; request both
      inputs without fabricating them.
    - "Based on everything you know about me, what goals should we build?" without a concrete
      outcome -> grill-with-docs because the route objective itself requires elicitation; use
      goal-prompt and plan as the two alternatives.

    {{ _.role("user") }}
    User prompt:
    {{ userPrompt }}

    Route taxonomy:
    {{ routeTaxonomy }}

    Capability catalog JSON:
    {{ capabilityCatalogJson }}

    Routing preference overlay JSON:
    {{ preferenceOverlayJson }}

    {{ ctx.output_format }}
  "#
}
