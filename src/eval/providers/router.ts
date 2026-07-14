import type { ApiProvider, ProviderResponse } from "promptfoo";
import {
  RouterRoute,
  loadTypedWeavekitConfig,
  type RouterDefaults,
  type RoutingPreferenceOverlay,
} from "../../config.js";
import { b } from "../../generated/baml_client/index.js";

export type RouterProviderResult = {
  route: RouterRoute;
  harness: string;
  ability?: string;
  model?: string;
  confidence: number;
  rationale: string;
  promptRewrite: string;
  alternatives: RouterRoute[];
  createWorktreeEligible: boolean;
  missingRequirements?: string[];
  warnings?: string[];
};

export type RouterAdvisor = {
  advise(prompt: string, context?: string): Promise<RouterProviderResult>;
};

export type RouterProviderOptions = {
  advisor?: RouterAdvisor;
  config?: Pick<RouterDefaults, "preferences">;
  id?: string;
};

export class RouterProvider implements ApiProvider {
  private readonly advisor: RouterAdvisor;
  private readonly providerId: string;

  constructor(options: RouterProviderOptions = {}) {
    this.advisor =
      options.advisor ?? createHeuristicRouterAdvisor(options.config?.preferences ?? []);
    this.providerId = options.id ?? "weavekit:router";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(
    prompt: string,
    context?: { vars?: Record<string, unknown> },
  ): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};
    const userPrompt = String(vars.prompt ?? vars.question ?? prompt);
    const contextText = Array.isArray(vars.contextItems)
      ? vars.contextItems.map((item) => String(item)).join("\n")
      : typeof vars.context === "string"
        ? vars.context
        : undefined;

    try {
      const result = await this.advisor.advise(userPrompt, contextText);
      return {
        output: formatRouterResult(result),
        metadata: routerResultMetadata(result),
      };
    } catch (error) {
      return { error: `router failed: ${(error as Error).message}` };
    }
  }
}

export type BamlRouterProviderOptions = {
  clientName: string;
  id: string;
  config?: RouterDefaults;
};

export class BamlRouterProvider implements ApiProvider {
  private readonly clientName: string;
  private readonly providerId: string;
  private readonly routerConfig: RouterDefaults;

  constructor(options: BamlRouterProviderOptions) {
    this.clientName = options.clientName;
    this.providerId = options.id;
    this.routerConfig = options.config ?? loadTypedWeavekitConfig().router;
  }

  id(): string {
    return this.providerId;
  }

  async callApi(
    prompt: string,
    context?: { vars?: Record<string, unknown> },
  ): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};
    const userPrompt = String(vars.prompt ?? vars.question ?? prompt);
    try {
      const result = normalizeBamlRouterResult(
        await b.RoutePrompt(
          userPrompt,
          renderRouteTaxonomy(),
          JSON.stringify(this.routerConfig.catalog, null, 2),
          JSON.stringify(this.routerConfig.preferences, null, 2),
          { client: this.clientName },
        ),
      );
      return {
        output: formatRouterResult(result),
        metadata: routerResultMetadata(result),
      };
    } catch (error) {
      return { error: `router failed: ${(error as Error).message}` };
    }
  }
}

export function createHeuristicRouterAdvisor(
  preferences: RoutingPreferenceOverlay[] = [],
): RouterAdvisor {
  return {
    async advise(prompt, context) {
      const text = `${prompt}\n${context ?? ""}`.toLowerCase();
      const forced = preferences.find(
        (preference) =>
          preference.force &&
          preference.prefer?.route &&
          preference.match.some((term) => text.includes(term.toLowerCase())),
      );
      const route = forced?.prefer?.route ?? inferRouterRoute(text);
      const profile = profileForRoute(route, text);
      const createWorktreeEligible =
        route === RouterRoute.MANUAL_HERDR_WORKTREE &&
        /project\s*[:=]\s*\S+/iu.test(prompt) &&
        /(?:branch|worktree)\s*[:=]\s*\S+/iu.test(prompt) &&
        /(?:harness|agent)\s*[:=]\s*\S+/iu.test(prompt);
      return {
        route,
        ...profile,
        confidence: forced ? Math.max(profile.confidence, 0.85) : profile.confidence,
        rationale: forced ? `${forced.rationale} ${profile.rationale}` : profile.rationale,
        promptRewrite: rewriteForRoute(route, prompt, text),
        alternatives: alternativesForRoute(route, text),
        createWorktreeEligible,
        missingRequirements: missingRequirementsForRoute(route, text, createWorktreeEligible),
        warnings: warningsForRoute(route, text, createWorktreeEligible),
      };
    },
  };
}

function inferRouterRoute(text: string): RouterRoute {
  if (/(?:what is|explain|define).{0,30}\/goal/u.test(text)) {
    return RouterRoute.DIRECT_ANSWER;
  }
  if (
    /(?:ambiguous|unclear|not sure|what should i ask|missing requirement|need help|need more context|need context|unknown|make this better|best place|based on everything you know|what \/goal prompts should we build)/u.test(
      text,
    )
  ) {
    return RouterRoute.GRILL_WITH_DOCS;
  }
  if (/(rewrite|improve|refine).{0,30}prompt/u.test(text)) {
    return RouterRoute.REFINE_PROMPT;
  }
  if (
    /(?:before we start|before anyone writes code|plan first|\/plan|implementation plan|plan before|milestones|task breakdown)/u.test(
      text,
    )
  ) {
    return RouterRoute.PLAN;
  }
  if (/(goal mode|\/goal|durable goal|keep working until done)/u.test(text)) {
    return RouterRoute.GOAL_PROMPT;
  }
  if (/(herdr|create worktree|manual worktree)/u.test(text)) {
    if (
      /project\s*[:=]\s*\S+/u.test(text) &&
      /(?:branch|worktree)\s*[:=]\s*\S+/u.test(text) &&
      /(?:harness|agent)\s*[:=]\s*\S+/u.test(text)
    ) {
      return RouterRoute.MANUAL_HERDR_WORKTREE;
    }
    if (/(create (?:a )?(?:herdr )?worktree|manual worktree)/u.test(text)) {
      return RouterRoute.GRILL_WITH_DOCS;
    }
  }
  if (
    /(source artifact|source article|source-to-project|map.*target project|opportunities)/u.test(
      text,
    )
  ) {
    return RouterRoute.SOURCE_TO_PROJECT;
  }
  if (
    /(fix|implement|patch|change code|bug|test failure|failing test|fails locally|local worktree)/u.test(
      text,
    )
  ) {
    return RouterRoute.LOCAL_CODE_CHANGE;
  }
  if (
    /(parallel|subagents|fleet|decompose|multiple agents|independent workers|split it across)/u.test(
      text,
    )
  ) {
    return RouterRoute.FLEET_PARALLEL;
  }
  if (/(remote pr|cloud agent|delegate.*pr|coding agent)/u.test(text)) {
    return RouterRoute.REMOTE_DELEGATE_PR;
  }
  if (/(tradeoff|decision council|choose between|recommend one|pros and cons)/u.test(text)) {
    return RouterRoute.DECISION_COUNCIL;
  }
  if (
    /(?:research|investigate|explore|compare|comparison|analyze|analysis|evidence|source docs|sources|latest|recent|current|benchmark|background|web research|citations|last 30 days)/u.test(
      text,
    )
  ) {
    return RouterRoute.RESEARCH;
  }
  return RouterRoute.DIRECT_ANSWER;
}

type RouterProfile = Pick<
  RouterProviderResult,
  "harness" | "ability" | "model" | "confidence" | "rationale"
>;

function profileForRoute(route: RouterRoute, text: string): RouterProfile {
  const profiles: Record<RouterRoute, RouterProfile> = {
    [RouterRoute.DIRECT_ANSWER]: {
      harness: "copilot-cli",
      ability: "direct-answer",
      model: "gpt-5.5",
      confidence: 0.78,
      rationale:
        "The request is a narrow, read-only question that can be answered in the current harness without spawning agents or mutating files. If exact repository-specific evidence is absent, ask for it rather than guessing.",
    },
    [RouterRoute.REFINE_PROMPT]: {
      harness: "copilot-cli",
      ability: "prompt-build",
      model: "gpt-5.5",
      confidence: 0.86,
      rationale:
        "The user explicitly asks to improve a prompt artifact rather than execute or delegate it. A handoff route becomes relevant only if the user later asks to run the rewritten prompt.",
    },
    [RouterRoute.GOAL_PROMPT]: {
      harness: "copilot-cli",
      ability: "goal",
      model: "gpt-5.5",
      confidence: 0.88,
      rationale:
        "The user explicitly requests durable goal-mode behavior with persistent remaining-work tracking and verification. A plan is the safer alternative when execution is not yet requested.",
    },
    [RouterRoute.PLAN]: {
      harness: "copilot-cli",
      ability: "task-plan",
      model: "claude-opus-4.8",
      confidence: 0.82,
      rationale:
        "The first requested action is planning before implementation or goal-mode execution. The plan should resolve dependencies and produce a safe handoff without starting work prematurely.",
    },
    [RouterRoute.GRILL_WITH_DOCS]: {
      harness: "copilot-cli",
      ability: "grill-with-docs",
      model: "claude-opus-4.8",
      confidence: 0.84,
      rationale:
        "The desired outcome or execution route is genuinely ambiguous, so targeted questions are required before choosing or launching a workflow. Missing scope must not be invented.",
    },
    [RouterRoute.RESEARCH]: {
      harness: "weavekit",
      ability: "deep-research",
      model: "claude-sonnet-5",
      confidence: 0.83,
      rationale:
        "The request depends on recent or multi-source evidence with citations. Planning or a direct answer is appropriate only after the necessary current evidence is available.",
    },
    [RouterRoute.FLEET_PARALLEL]: {
      harness: "copilot-cli",
      ability: "orchestration",
      model: "gpt-5.5",
      confidence: 0.8,
      rationale:
        "The user explicitly asks to split separable, multi-surface work across independent workers. A single local editor is preferable only when the scopes are tightly coupled.",
    },
    [RouterRoute.REMOTE_DELEGATE_PR]: {
      harness: "copilot-coding-agent",
      ability: "pull-request",
      model: "gpt-5.3-codex",
      confidence: 0.81,
      rationale:
        "The user explicitly asks for cloud or remote delegation that produces a pull request. Missing repository or scope details belong in the handoff prompt rather than changing the selected route.",
    },
    [RouterRoute.DECISION_COUNCIL]: {
      harness: "weavekit",
      ability: "decision-council",
      model: "gpt-5.5",
      confidence: 0.82,
      rationale:
        "The prompt asks for a tradeoff-heavy decision before implementation. Planning becomes the next step after the alternatives, objections, and recommendation are resolved.",
    },
    [RouterRoute.SOURCE_TO_PROJECT]: {
      harness: "weavekit",
      ability: "source-to-project",
      model: "claude-opus-4.8",
      confidence: 0.83,
      rationale:
        "The user explicitly requests the source-to-project workflow. Missing source or target identifiers must be requested in the rewrite rather than fabricated or used to reroute the request.",
    },
    [RouterRoute.MANUAL_HERDR_WORKTREE]: {
      harness: "herdr",
      ability: "manual-create-worktree",
      model: "gpt-5.3-codex",
      confidence: 0.82,
      rationale:
        "The prompt supplies the complete project, branch or worktree, agent or harness, and task fields for a manual, user-controlled Herdr handoff. The advisory workflow must not auto-launch it.",
    },
    [RouterRoute.LOCAL_CODE_CHANGE]: {
      harness: "codex-cli",
      ability: "local-code-change",
      model: "gpt-5.3-codex",
      confidence: 0.84,
      rationale:
        "The prompt requests a concrete code mutation in the current worktree with validation. Read-only advice or planning alone would not satisfy the requested implementation outcome.",
    },
  };
  const profile = profiles[route];

  if (route === RouterRoute.LOCAL_CODE_CHANGE) {
    return {
      ...profile,
      harness: text.includes("codex") ? "codex-cli" : "copilot-cli",
    };
  }
  if (route === RouterRoute.GOAL_PROMPT && isGoalPromptArtifactRequest(text)) {
    return {
      ...profile,
      rationale:
        "The user asks for a production-ready /goal prompt for a known outcome, including success criteria, constraints, and checkpoints, but explicitly says do not execute it. If the outcome were still vague, grill-with-docs would be safer.",
    };
  }
  if (route === RouterRoute.PLAN && text.includes("/goal")) {
    return {
      ...profile,
      rationale:
        "The first requested action is a plan; the mentioned /goal is a later handoff, not the current route. Planning must complete before goal mode starts.",
    };
  }
  if (route === RouterRoute.GRILL_WITH_DOCS) {
    return {
      ...profile,
      rationale: grillRationale(text),
    };
  }
  return profile;
}

function isGoalPromptArtifactRequest(text: string): boolean {
  return (
    /(?:write|draft|create|build).{0,50}\/goal prompt/u.test(text) ||
    /do not (?:start|execute|run).{0,30}goal/u.test(text)
  );
}

function grillRationale(text: string): string {
  if (/based on everything you know|broad context|private memory|project priorities/u.test(text)) {
    return "The request relies on broad implicit context instead of a concrete desired outcome. Targeted elicitation is required; do not invent private memory or project priorities.";
  }
  if (/make this better|write the goal/u.test(text)) {
    return 'The user asks for a goal but provides not enough context to identify what should improve or how success is measured. Do not invent what "this" means.';
  }
  if (/best place|local, remote|execution preference/u.test(text)) {
    return "The change request is too vague to choose local, remote, or manual execution safely. Do not guess the target, exact change, or execution preference.";
  }
  if (/herdr|worktree/u.test(text)) {
    return "A manual Herdr handoff is requested without every required safety field. The missing project, branch or worktree, agent or harness, and task prompt must be elicited before eligibility.";
  }
  return "The desired outcome, constraints, or definition of success are genuinely ambiguous. Targeted questions are required before selecting a workflow, and missing scope must not be invented.";
}

function rewriteForRoute(route: RouterRoute, prompt: string, text: string): string {
  const original = prompt.trim();
  switch (route) {
    case RouterRoute.DIRECT_ANSWER:
      return `Answer this narrow question directly and concisely without starting a workflow, spawning an agent, or mutating files: ${original} If the exact error text or repository-specific evidence needed to answer is missing, ask for that evidence instead of guessing.`;
    case RouterRoute.REFINE_PROMPT:
      return `Rewrite the following for its intended${text.includes("copilot coding agent") ? " Copilot coding agent" : ""} audience with a clear objective, relevant context, constraints, acceptance criteria, and verification steps. Return only the rewritten prompt; do not run it, start an agent, or delegate execution: ${original}`;
    case RouterRoute.GOAL_PROMPT:
      if (isGoalPromptArtifactRequest(text)) {
        return `Write a production-ready /goal prompt for the stated outcome. Include explicit scope, success criteria, constraints, checkpoints, verification evidence, and a strict stop condition. Return the prompt only; do not start or execute goal mode. Outcome request: ${original}`;
      }
      return `/goal Execute the requested outcome end-to-end. Inspect the real state first, persist remaining work, fix every in-scope issue, preserve existing behavior, run relevant validation, and finish only with evidence that all success criteria are met. Requested outcome: ${original}`;
    case RouterRoute.PLAN:
      return `Produce a goal-ready implementation plan for this request: ${original} Cover requirements, architecture, dependencies, milestones, risks, tests, and completion evidence. Do not modify code or start goal mode; the completed plan may be converted into a /goal afterward.`;
    case RouterRoute.GRILL_WITH_DOCS:
      return grillRewrite(text);
    case RouterRoute.RESEARCH:
      return `Research this request using current, authoritative sources: ${original} Compare the evidence, cite sources, separate facts from inference, identify gaps, and produce a decision-ready synthesis without relying on stale memory.`;
    case RouterRoute.LOCAL_CODE_CHANGE:
      return `Inspect the current worktree, reproduce the issue, implement the smallest complete fix for this request, and run the relevant tests and static checks: ${original} Preserve unrelated changes and do not stop at analysis when a code fix is requested.`;
    case RouterRoute.FLEET_PARALLEL:
      return `Coordinate independent workers for this request: ${original} Define non-overlapping scopes for each named surface, including BAML, CLI, tests, dashboard, and docs when present; record dependencies and deliverables, prevent duplicate work, integrate the results, and run end-to-end verification.`;
    case RouterRoute.REMOTE_DELEGATE_PR:
      return `Delegate this bounded task to a remote coding agent and require a pull request: ${original} Confirm the target repository, base branch, exact scope, acceptance criteria, and validation commands in the handoff; keep the current worktree unchanged and do not invent missing repository details.`;
    case RouterRoute.DECISION_COUNCIL:
      return `Evaluate the stated options before implementation: ${original} Compare decision criteria, strongest objections, tradeoffs, risks, and evidence, then recommend one option and state the conditions that would change the decision.`;
    case RouterRoute.SOURCE_TO_PROJECT:
      return `Run the source-to-project workflow for this request: ${original} If absent, first request the source artifact or URL and the target project identifier or path; then map source evidence to the project, rank actionable opportunities, and do not invent either input.`;
    case RouterRoute.MANUAL_HERDR_WORKTREE:
      return `Prepare a manual Herdr Create Worktree handoff using the supplied Project, Branch or Worktree, and Agent or Harness fields. Give the selected agent a bounded implementation prompt based on: ${original} Keep launch user-controlled and do not auto-create or auto-start the worktree.`;
  }
}

function grillRewrite(text: string): string {
  if (/based on everything you know|broad context|private memory|project priorities/u.test(text)) {
    return "Before proposing any /goal prompts, ask for the desired outcome, relevant context the user wants considered, current project state, priorities and constraints, and observable success criteria. Use only context the user confirms; do not infer private memory or missing project priorities.";
  }
  if (/make this better|write the goal/u.test(text)) {
    return 'Ask what should be improved, which artifact or behavior "this" refers to, the desired outcome, constraints, and how success will be measured. After those answers, produce the /goal prompt without inventing scope.';
  }
  if (/best place|local, remote|execution preference/u.test(text)) {
    return "Ask for the target repository or project, the exact change to make, the relevant current state, the preferred execution mode (local worktree, remote PR, or manual handoff), and the required deliverable before choosing a route.";
  }
  if (/herdr|worktree/u.test(text)) {
    return "Ask for the target project, branch or worktree name, harness or agent, and the complete task prompt. Keep Create Worktree ineligible until every field is explicitly supplied.";
  }
  return "Ask for the concrete objective, affected artifact or system, constraints, available context, desired execution mode, and observable definition of success before selecting or launching a workflow.";
}

function alternativesForRoute(route: RouterRoute, text: string): RouterRoute[] {
  switch (route) {
    case RouterRoute.DIRECT_ANSWER:
      return text.includes("/goal")
        ? [RouterRoute.REFINE_PROMPT, RouterRoute.PLAN]
        : text.includes("status")
          ? [RouterRoute.PLAN, RouterRoute.RESEARCH]
          : [RouterRoute.REFINE_PROMPT, RouterRoute.RESEARCH];
    case RouterRoute.REFINE_PROMPT:
      return text.includes("coding agent")
        ? [RouterRoute.REMOTE_DELEGATE_PR, RouterRoute.GOAL_PROMPT]
        : text.includes("/goal")
          ? [RouterRoute.GOAL_PROMPT, RouterRoute.DIRECT_ANSWER]
          : [RouterRoute.DIRECT_ANSWER, RouterRoute.GOAL_PROMPT];
    case RouterRoute.GOAL_PROMPT:
      return isGoalPromptArtifactRequest(text)
        ? [RouterRoute.PLAN, RouterRoute.GRILL_WITH_DOCS]
        : [RouterRoute.PLAN, RouterRoute.LOCAL_CODE_CHANGE];
    case RouterRoute.PLAN:
      return text.includes("/goal")
        ? [RouterRoute.GOAL_PROMPT, RouterRoute.GRILL_WITH_DOCS]
        : [RouterRoute.GRILL_WITH_DOCS, RouterRoute.LOCAL_CODE_CHANGE];
    case RouterRoute.GRILL_WITH_DOCS:
      if (/based on everything you know|write the goal|make this better/u.test(text)) {
        return [RouterRoute.GOAL_PROMPT, RouterRoute.PLAN];
      }
      if (/herdr|worktree/u.test(text)) {
        return [RouterRoute.MANUAL_HERDR_WORKTREE, RouterRoute.PLAN];
      }
      if (/best place|execution preference/u.test(text)) {
        return [RouterRoute.PLAN, RouterRoute.LOCAL_CODE_CHANGE];
      }
      return [RouterRoute.PLAN, RouterRoute.DIRECT_ANSWER];
    case RouterRoute.RESEARCH:
      return [RouterRoute.PLAN, RouterRoute.DIRECT_ANSWER];
    case RouterRoute.LOCAL_CODE_CHANGE:
      return /test failure|failing test|fails locally/u.test(text)
        ? [RouterRoute.DIRECT_ANSWER, RouterRoute.PLAN]
        : [RouterRoute.REMOTE_DELEGATE_PR, RouterRoute.PLAN];
    case RouterRoute.FLEET_PARALLEL:
      return [RouterRoute.LOCAL_CODE_CHANGE, RouterRoute.PLAN];
    case RouterRoute.REMOTE_DELEGATE_PR:
      return [RouterRoute.LOCAL_CODE_CHANGE, RouterRoute.MANUAL_HERDR_WORKTREE];
    case RouterRoute.DECISION_COUNCIL:
      return [RouterRoute.PLAN, RouterRoute.RESEARCH];
    case RouterRoute.SOURCE_TO_PROJECT:
      return [RouterRoute.GRILL_WITH_DOCS, RouterRoute.PLAN];
    case RouterRoute.MANUAL_HERDR_WORKTREE:
      return [RouterRoute.LOCAL_CODE_CHANGE, RouterRoute.GRILL_WITH_DOCS];
  }
}

function missingRequirementsForRoute(
  route: RouterRoute,
  text: string,
  createWorktreeEligible: boolean,
): string[] {
  if (route === RouterRoute.SOURCE_TO_PROJECT) {
    const requirements: string[] = [];
    if (!/https?:\/\/|source (?:artifact|article|url)\s*[:=]/u.test(text)) {
      requirements.push("source artifact or URL");
    }
    if (!/(?:target )?project\s*[:=]\s*\S+|repository\s*[:=]\s*\S+/u.test(text)) {
      requirements.push("target project identifier or path");
    }
    return requirements;
  }
  if (route === RouterRoute.REMOTE_DELEGATE_PR) {
    return ["target repository and base branch", "bounded PR scope and acceptance criteria"];
  }
  if (route === RouterRoute.GRILL_WITH_DOCS) {
    if (/herdr|worktree/u.test(text) && !createWorktreeEligible) {
      return ["project", "branch or worktree name", "harness or agent", "task prompt"];
    }
    return ["concrete objective", "constraints", "observable definition of success"];
  }
  return [];
}

function warningsForRoute(
  route: RouterRoute,
  _text: string,
  createWorktreeEligible: boolean,
): string[] {
  const warnings: Record<RouterRoute, string[]> = {
    [RouterRoute.DIRECT_ANSWER]: ["Do not spawn agents or mutate files for a narrow explanation."],
    [RouterRoute.REFINE_PROMPT]: [
      "Do not start an agent or execute the task while refining the prompt.",
    ],
    [RouterRoute.GOAL_PROMPT]: [
      "Do not declare the goal complete without persisted remaining-work tracking and verification evidence.",
    ],
    [RouterRoute.PLAN]: ["Do not start implementation or goal mode before the plan is complete."],
    [RouterRoute.GRILL_WITH_DOCS]: [
      "Do not invent missing scope, private context, project identifiers, or success criteria.",
    ],
    [RouterRoute.RESEARCH]: [
      "Do not answer a current-evidence request from stale memory without cited sources.",
    ],
    [RouterRoute.LOCAL_CODE_CHANGE]: [
      "Preserve unrelated worktree changes and validate the implementation before completion.",
    ],
    [RouterRoute.FLEET_PARALLEL]: [
      "Do not duplicate work across agents or parallelize tightly coupled scopes.",
    ],
    [RouterRoute.REMOTE_DELEGATE_PR]: [
      "Keep the current worktree unchanged and do not send secrets or unbounded scope to the remote agent.",
    ],
    [RouterRoute.DECISION_COUNCIL]: [
      "Do not implement before the decision and its tradeoffs are resolved.",
    ],
    [RouterRoute.SOURCE_TO_PROJECT]: [
      "Do not invent the source artifact, target project, or source-derived evidence.",
    ],
    [RouterRoute.MANUAL_HERDR_WORKTREE]: [
      createWorktreeEligible
        ? "Do not auto-launch; the user must control the manual Herdr Create Worktree action."
        : "Do not mark Create Worktree eligible until every required handoff field is present.",
    ],
  };
  return warnings[route];
}

function normalizeBamlRouterResult(
  result: Awaited<ReturnType<typeof b.RoutePrompt>>,
): RouterProviderResult {
  const route = normalizeGeneratedRoute(String(result.primary.route));
  return {
    route,
    harness: result.primary.harness,
    ability: result.primary.ability ?? undefined,
    model: result.primary.model ?? undefined,
    confidence: result.primary.confidence,
    rationale: result.primary.rationale,
    promptRewrite: result.primary.promptRewrite?.trim() ?? "",
    alternatives: result.alternatives.map((alternative) =>
      normalizeGeneratedRoute(String(alternative.route)),
    ),
    createWorktreeEligible:
      route === RouterRoute.MANUAL_HERDR_WORKTREE &&
      Boolean(result.primary.handoff?.createWorktreeEligible),
    missingRequirements: result.primary.handoff?.missingRequirements ?? [],
    warnings: result.warnings,
  };
}

function routerResultMetadata(result: RouterProviderResult): Record<string, unknown> {
  return {
    route: result.route,
    harness: result.harness,
    ability: result.ability,
    model: result.model,
    confidence: result.confidence,
    rationale: result.rationale,
    promptRewrite: result.promptRewrite,
    alternatives: result.alternatives,
    createWorktreeEligible: result.createWorktreeEligible,
    missingRequirements: result.missingRequirements,
    warnings: result.warnings,
  };
}

function normalizeGeneratedRoute(route: string): RouterRoute {
  const routeMap: Record<string, RouterRoute> = {
    DirectAnswer: RouterRoute.DIRECT_ANSWER,
    RefinePrompt: RouterRoute.REFINE_PROMPT,
    GoalPrompt: RouterRoute.GOAL_PROMPT,
    Plan: RouterRoute.PLAN,
    GrillWithDocs: RouterRoute.GRILL_WITH_DOCS,
    Research: RouterRoute.RESEARCH,
    LocalCodeChange: RouterRoute.LOCAL_CODE_CHANGE,
    FleetParallel: RouterRoute.FLEET_PARALLEL,
    RemoteDelegatePr: RouterRoute.REMOTE_DELEGATE_PR,
    DecisionCouncil: RouterRoute.DECISION_COUNCIL,
    SourceToProject: RouterRoute.SOURCE_TO_PROJECT,
    ManualHerdrWorktree: RouterRoute.MANUAL_HERDR_WORKTREE,
  };
  return routeMap[route] ?? RouterRoute.GRILL_WITH_DOCS;
}

function renderRouteTaxonomy(): string {
  return [
    "direct-answer: Concise read-only guidance for narrow factual questions; do not over-orchestrate.",
    "refine-prompt: User wants a clearer prompt.",
    "goal-prompt: Durable goal-mode execution or goal-mode prompt rewrite.",
    "plan: Implementation plan before coding.",
    "grill-with-docs: Genuine route ambiguity or incomplete manual Herdr project/branch/agent/task fields.",
    "research: Current, recent, external, or multi-source evidence that must precede downstream planning.",
    "local-code-change: Inspect, fix, and validate code in the current worktree without inventing extra approval gates.",
    "fleet-parallel: Complex work decomposable across parallel subagents.",
    "remote-delegate-pr: Remote/cloud PR-producing agent handoff.",
    "decision-council: Tradeoff-heavy recommendation.",
    "source-to-project: Map source artifact against target project.",
    "manual-herdr-worktree: User-controlled Herdr handoff with project, branch/worktree, agent/harness, and actionable task; the router generates the final rewrite.",
  ].join("\n");
}

function formatRouterResult(result: RouterProviderResult): string {
  return [
    `Route: ${result.route}`,
    `Harness: ${result.harness}`,
    `Ability: ${result.ability ?? "n/a"}`,
    `Model: ${result.model ?? "n/a"}`,
    `Confidence: ${result.confidence}`,
    `Rationale: ${result.rationale}`,
    `Prompt rewrite: ${result.promptRewrite}`,
    `Alternatives: ${result.alternatives.join(", ")}`,
    `Create Worktree eligible: ${result.createWorktreeEligible}`,
    `Missing requirements: ${result.missingRequirements?.join(", ") || "none"}`,
    `Warnings: ${result.warnings?.join(" ") || "none"}`,
  ].join("\n");
}
