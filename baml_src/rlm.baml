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
