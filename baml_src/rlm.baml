class RlmRunBrief {
  objective string
  constraints string[]
  acceptanceCriteria string[]
  validationCommands string[]
}

enum RlmWorkerOutcome {
  COMPLETED
  NEEDS_HUMAN
  FAILED
}

enum RlmVerificationOutcome {
  PASSED
  FAILED
  NOT_RUN
}

class RlmVerificationResult {
  commandOrMethod string
  outcome RlmVerificationOutcome
  summary string
}

class RlmArtifactReference {
  locator string
  description string
}

class RlmWorkerReport {
  outcome RlmWorkerOutcome
  summary string
  evidence EvidenceReference[]
  artifacts RlmArtifactReference[]
  verification RlmVerificationResult[]
  decisions string[]
  risks string[]
  openQuestions string[]
  remainingWork string[]
}

class RlmDependencyReport {
  callId string
  profile string
  report RlmWorkerReport
}

enum TrellageTurnOutcome {
  ACHIEVED
  NEEDS_INFORMATION
  BLOCKED
  REFUSED
}

class TrellageTurnDiagnosis {
  outcome TrellageTurnOutcome
  summary string
}

function DiagnoseTrellageTurn(
  originalGoal: string,
  terminalSummary: string,
  harnessOutcome: string,
  changedFiles: string[]
) -> TrellageTurnDiagnosis {
  client CopilotProxyClaudeHaiku45
  prompt #"
    {{ _.role("user") }}
    Diagnose whether one completed agent-harness turn achieved its original goal.

    Treat harness-reported success as a transport fact only, not proof that the goal was achieved.
    Use only the supplied facts. Do not invent file changes, test results, or user decisions.

    Return:
    - ACHIEVED only when the terminal summary provides sufficient evidence that the original goal was completed.
    - NEEDS_INFORMATION when the task needs a missing user decision or clarification.
    - BLOCKED when an external failure, missing dependency, or incomplete work prevents completion.
    - REFUSED when the harness declined the requested work.

    Original goal:
    {{ originalGoal }}

    Normalized harness outcome:
    {{ harnessOutcome }}

    Changed-file evidence:
    {{ changedFiles }}

    Terminal summary:
    {{ terminalSummary }}

    {{ ctx.output_format }}
  "#
}

function DeriveRlmRunBrief(rawObjective: string) -> RlmRunBrief {
  client CopilotProxyClaudeHaiku45
  prompt #"
    {{ _.role("user") }}
    Convert one raw user request into the structured run brief that every worker in a bounded
    delegation run will receive as its shared acceptance contract.

    Extract only what the request states or clearly implies. Leave an array empty rather than
    invent an entry. An empty array is a correct answer. A fabricated entry is not, because every
    worker will treat each entry as binding.

    - objective: restate the request as one complete, self-contained statement of what must be
      true when the work is done. Keep every concrete detail: named paths, identifiers, versions,
      and quantities. Do not summarize the specifics away.
    - constraints: limits on how the work may be done. Scope boundaries, prohibited actions,
      required tools or libraries, and process rules the request states.
    - acceptanceCriteria: independently checkable statements that must all hold before the work
      is accepted. Each one must be verifiable by inspection, by a command, or by an observable
      artifact. Split a compound requirement into separate criteria. Do not restate the objective
      as a single criterion.
    - validationCommands: exact commands the request names, or that the request's own stated
      conventions make unambiguous. Copy each command verbatim. Do not guess a project's test or
      build command when the request does not name it.

    Raw request:
    {{ rawObjective }}

    {{ ctx.output_format }}
  "#
}

function RenderRlmWorkerTask(
  brief: RlmRunBrief,
  delegatedTask: string,
  dependencies: RlmDependencyReport[]
) -> RlmWorkerReport {
  client CopilotProxyClaudeHaiku45
  prompt #"
    {{ _.role("user") }}
    You are the worker for one delegated RLM task.
    Complete only the delegated task below.
    Only the supplied dependency reports are available. Do not assume any other dependencies, hidden context, or unstated prior work.
    Return an evidence-based RlmWorkerReport. Ground each claim in the run brief, the delegated task, or the supplied dependency reports. If evidence is missing, record that in risks or openQuestions.

    Run brief:
    {{ brief }}

    Delegated task:
    {{ delegatedTask }}

    Supplied dependency reports:
    {{ dependencies }}

    {{ ctx.output_format }}
  "#
}
