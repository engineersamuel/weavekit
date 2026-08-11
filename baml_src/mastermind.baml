enum MastermindAction {
  REVIEW_TICKET
  IMPLEMENT_DIRECTLY
  DELEGATE_SUBMIND
  WAIT
  NEEDS_HUMAN
  IGNORE
}

enum PostImplementationReviewVerdict {
  PASS
  CHANGES_REQUIRED
  NEEDS_HUMAN
}

enum TicketKind {
  USER_STORY
  BUG
  TECHNICAL_TASK
  SPIKE
  OPERATIONAL
}

enum ReviewEvidenceKind {
  REPOSITORY
  LINEAR
  EXTERNAL
}

enum ProjectRepositoryMode {
  EXISTING_REPOSITORY
  GREENFIELD
}

enum RepositoryEvidenceType {
  FILE
  SYMBOL
  SEARCH
}

enum ReviewReadiness {
  READY
  READY_WITH_NONBLOCKING_GAPS
  BLOCKED
}

enum ReviewOpenItemOwner {
  HUMAN
  EXECUTOR_PREFLIGHT
  IMPLEMENTATION_DISCOVERY
  EXTERNAL_DEPENDENCY
}

enum ReviewOpenItemKind {
  UNANSWERED_QUESTION
  BLOCKING_REASON
}

class MastermindProjectPolicyInput {
  id string
  displayName string
  repositoryMode ProjectRepositoryMode
  repositoryPath string?
  provisioningRoot string?
  allowedActions MastermindAction[]
}

class LinearTicketInput {
  id string
  identifier string
  title string
  description string
  labels string[]
  status string
  projectId string?
  teamId string
}

class TicketReviewEvidence {
  id string
  kind ReviewEvidenceKind
  locator string?
  repositoryEvidenceType RepositoryEvidenceType?
  repositoryPath string?
  repositoryLine int?
  repositorySymbol string?
  repositoryQuery string?
  claim string
  confidence float
}

class TicketReviewDossier {
  ticketKind TicketKind
  preservedIntent string
  summary string
  repositoryEvidence TicketReviewEvidence[]
  linearEvidence TicketReviewEvidence[]
  externalEvidence TicketReviewEvidence[]
  assumptions string[]
  ambiguities string[]
  unansweredQuestions string[]
  risks string[]
  dependencies string[]
  suggestedAcceptanceCriteria string[]
  automatedVerification string[]
  manualVerification string[]
  validationSteps string[]
  observability string[]
  rolloutPlan string[]
  rollbackPlan string[]
  outOfScope string[]
  materialScopeChange bool
  confidence float
}

class ReviewOpenItemDisposition {
  kind ReviewOpenItemKind
  text string
  owner ReviewOpenItemOwner
  rationale string
}

class ProposedLinearTicketPatch {
  proposedTitle string
  proposedDescriptionMarkdown string
  ticketKind TicketKind
  preservedIntent string
  acceptanceCriteria string[]
  assumptions string[]
  ambiguities string[]
  unansweredQuestions string[]
  openItemDispositions ReviewOpenItemDisposition[]
  dependencies string[]
  risks string[]
  automatedVerification string[]
  manualVerification string[]
  validationSteps string[]
  observability string[]
  rolloutPlan string[]
  rollbackPlan string[]
  outOfScope string[]
  evidence TicketReviewEvidence[]
  readiness ReviewReadiness
  blockingReasons string[]
  warnings string[]
  materialScopeChange bool
  requiresHumanApproval bool
  confidence float
}

class MastermindReviewDecisionContext {
  hasCurrentReview bool
  readiness ReviewReadiness?
  requiresHumanApproval bool
  blockingReasons string[]
  warnings string[]
  unansweredQuestions string[]
  openItemDispositions ReviewOpenItemDisposition[]
  reviewConfidence float?
}

class MastermindNextActionDecision {
  action MastermindAction
  rationale string
  prerequisites string[]
  policyEvidence string[]
  suggestedExecutorShape string?
  confidence float
}

class PostImplementationReviewFinding {
  severity "BLOCKING" | "IMPORTANT" | "SUGGESTION"
  summary string
  evidence string[]
  remediation string?
}

class PostImplementationReviewDossier {
  summary string
  acceptanceCriteriaCoverage string[]
  verificationAssessment string[]
  manualVerification string[]
  findings PostImplementationReviewFinding[]
  knownRisks string[]
  unansweredQuestions string[]
  confidence float
}

class PostImplementationReview {
  verdict PostImplementationReviewVerdict
  summary string
  acceptanceCriteriaCoverage string[]
  verificationAssessment string[]
  manualVerification string[]
  findings PostImplementationReviewFinding[]
  knownRisks string[]
  unansweredQuestions string[]
  confidence float
}

function SynthesizeLinearTicketPatch(
  ticket: LinearTicketInput,
  project: MastermindProjectPolicyInput,
  dossier: TicketReviewDossier
) -> ProposedLinearTicketPatch {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    You are Mastermind's typed ticket-patch synthesizer. A read-only frontier harness has
    investigated the configured project context and produced an evidence dossier. Produce a
    complete proposed Linear title and Markdown description without inventing facts.

    Rules:
    - Preserve the user's factual intent.
    - Use repository or external claims only when the dossier provides evidence.
    - Keep unanswered product decisions as questions or blocking reasons. Never silently decide.
    - Keep the existing string arrays. openItemDispositions classifies unansweredQuestions and
      blockingReasons; it does not replace them.
    - For every unansweredQuestions entry, emit exactly one openItemDispositions entry with kind
      UNANSWERED_QUESTION and the exact same text after trimming.
    - For every blockingReasons entry, emit exactly one openItemDispositions entry with kind
      BLOCKING_REASON and the exact same text after trimming.
    - Do not emit openItemDispositions entries for any other text.
    - Use HUMAN for product behavior, acceptance intent, authorization, scope approval, account
      choice, or another decision the executor must not make.
    - Use EXECUTOR_PREFLIGHT for tool or package availability, credentials or auth state, selected
      tenant or account context, runtime version, or another environment fact that can be proven
      fail-closed immediately before implementation starts.
    - Use IMPLEMENTATION_DISCOVERY for bounded repository or code investigation that is part of
      implementation and does not change product intent.
    - Use EXTERNAL_DEPENDENCY for a known blocker outside executor control, such as an upstream
      outage, pending vendor access, or an external system that must become available before work
      can start. Do not use EXECUTOR_PREFLIGHT for external waiting.
    - The description must stand alone and contain: Goal, Context, Scope, Out of scope,
      Acceptance criteria, Assumptions, Open questions, Dependencies, Risks, Verification,
      Validation, Observability, Rollout, Rollback, and Evidence.
    - Verification means proving the implementation is correct.
    - Validation means proving the intended user or system outcome was achieved.
    - READY requires no blocking reasons, unanswered questions, or openItemDispositions.
    - READY_WITH_NONBLOCKING_GAPS may have warnings and EXECUTOR_PREFLIGHT or
      IMPLEMENTATION_DISCOVERY open items, but no blocking reasons, no HUMAN open items, and no
      EXTERNAL_DEPENDENCY open items.
    - BLOCKED requires at least one blocking reason.
    - requiresHumanApproval must be true when any openItemDispositions owner is HUMAN or when
      materialScopeChange is true.
    - A BLOCKED patch may set requiresHumanApproval false only when every openItemDispositions
      owner is EXTERNAL_DEPENDENCY so Mastermind can route it to WAIT.
    - EXECUTOR_PREFLIGHT or IMPLEMENTATION_DISCOVERY blockers must never be treated as
      WAIT-eligible external dependencies.
    - materialScopeChange requiresHumanApproval.
    - For GREENFIELD projects, repository evidence is expected to be empty because no repository
      exists yet. Do not treat the provisioning root as the project repository.
    - Do not claim work is complete or prescribe commands not supported by available evidence.
    - Keep the title concise.
    - confidence is between 0 and 1.

    {{ _.role("user") }}
    Ticket:
    {{ ticket }}

    Resolved project policy:
    {{ project }}

    Read-only harness dossier:
    {{ dossier }}

    {{ ctx.output_format }}
  "#
}

function DecideNextAction(
  ticket: LinearTicketInput,
  project: MastermindProjectPolicyInput,
  review: MastermindReviewDecisionContext
) -> MastermindNextActionDecision {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    You are Mastermind's next-action classifier. Return exactly one typed action.

    Rules:
    - If review.hasCurrentReview is false, choose REVIEW_TICKET.
    - If review.requiresHumanApproval is true, choose NEEDS_HUMAN.
    - If review.readiness is BLOCKED, review.openItemDispositions is not empty, and every
      review.openItemDispositions owner is EXTERNAL_DEPENDENCY, choose WAIT.
    - If review.readiness is BLOCKED for any other reason, choose NEEDS_HUMAN.
    - If any review.openItemDispositions owner is HUMAN, choose NEEDS_HUMAN.
    - Choose only an action allowed by project.allowedActions.
    - IMPLEMENT_DIRECTLY means one bounded implementation worker is sufficient.
    - DELEGATE_SUBMIND means planning, fan-out, synthesis, or multiple workers are likely needed.
    - WAIT means a known external prerequisite is pending.
    - NEEDS_HUMAN means required information or authorization is unavailable.
    - IGNORE means the ticket is outside configured project policy.
    - Do not execute an action.
    - If labels contain mastermind-needs-input, choose NEEDS_HUMAN.
    - Executor-preflight unanswered questions may lead to an implementation action only when every
      EXECUTOR_PREFLIGHT open item with kind UNANSWERED_QUESTION is repeated verbatim in
      prerequisites.
    - BLOCKING_REASON open items must never be treated as implementation prerequisites.
    - EXTERNAL_DEPENDENCY items must never be restated as executor preflight prerequisites.
    - IMPLEMENTATION_DISCOVERY unanswered questions may remain inside a bounded implementation
      shape.
    - BLOCKED reviews may route to WAIT only when every blocking reason and unanswered question is
      owned by EXTERNAL_DEPENDENCY.
    - Do not treat a polished or reviewed ticket as implementation-ready by itself.
    - confidence is between 0 and 1.

    {{ _.role("user") }}
    Ticket:
    {{ ticket }}

    Resolved project policy:
    {{ project }}

    Current review context:
    {{ review }}

    {{ ctx.output_format }}
  "#
}

function AssessPostImplementationReview(
  ticket: LinearTicketInput,
  dossier: PostImplementationReviewDossier
) -> PostImplementationReview {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    You are Mastermind's typed post-implementation review synthesizer. This is code review after
    implementation, not ticket-readiness review. Do not rewrite requirements or claim success
    without evidence.

    Rules:
    - PASS requires no BLOCKING or IMPORTANT findings, no unanswered questions, concrete
      acceptance-criteria coverage, and credible verification assessment.
    - CHANGES_REQUIRED means implementation defects or missing required behavior can be fixed by
      another implementation attempt without a product decision.
    - NEEDS_HUMAN means product intent, authorization, acceptance, or another human-owned decision
      is unresolved.
    - Preserve findings and evidence from the dossier. Do not invent repository evidence.
    - Manual verification must be specific and actionable.
    - confidence is between 0 and 1.

    {{ _.role("user") }}
    Frozen reviewed ticket:
    {{ ticket }}

    Independent code-review dossier:
    {{ dossier }}

    {{ ctx.output_format }}
  "#
}

test SynthesizeLinearTicketPatch_Basic {
  functions [SynthesizeLinearTicketPatch]
  args {
    ticket {
      id "issue-1"
      identifier "WK-1"
      title "Add retry"
      description "It should retry sometimes."
      labels []
      status "Todo"
      teamId "team-1"
    }
    project {
      id "weavekit"
      displayName "Weavekit"
      repositoryPath "/tmp/weavekit"
      allowedActions [REVIEW_TICKET, IMPLEMENT_DIRECTLY, DELEGATE_SUBMIND, NEEDS_HUMAN]
    }
    dossier {
      ticketKind TECHNICAL_TASK
      preservedIntent "Add bounded retry behavior."
      summary "The ticket needs explicit retry and validation behavior."
      repositoryEvidence []
      linearEvidence []
      externalEvidence []
      assumptions []
      ambiguities ["Retryable failures are not identified."]
      unansweredQuestions ["Which failures are retryable?"]
      risks ["Unbounded retries can amplify failures."]
      dependencies []
      suggestedAcceptanceCriteria ["Retries stop at a configured maximum."]
      automatedVerification []
      manualVerification []
      validationSteps []
      observability []
      rolloutPlan []
      rollbackPlan []
      outOfScope []
      materialScopeChange false
      confidence 0.8
    }
  }
}

test DecideNextAction_Unreviewed {
  functions [DecideNextAction]
  args {
    ticket {
      id "issue-1"
      identifier "WK-1"
      title "Add retry"
      description "It should retry sometimes."
      labels []
      status "Todo"
      teamId "team-1"
    }
    project {
      id "weavekit"
      displayName "Weavekit"
      repositoryPath "/tmp/weavekit"
      allowedActions [REVIEW_TICKET, IMPLEMENT_DIRECTLY, DELEGATE_SUBMIND, NEEDS_HUMAN]
    }
    review {
      hasCurrentReview false
      requiresHumanApproval false
      blockingReasons []
      warnings []
      unansweredQuestions []
      openItemDispositions []
    }
  }
}

test DecideNextAction_ReadyReviewWithoutGaps {
  functions [DecideNextAction]
  args {
    ticket {
      id "issue-2"
      identifier "WK-2"
      title "Tighten review routing"
      description "Use the stored review dossier before action planning."
      labels ["Mastermind Reviewed"]
      status "Todo"
      teamId "team-1"
    }
    project {
      id "weavekit"
      displayName "Weavekit"
      repositoryPath "/tmp/weavekit"
      allowedActions [REVIEW_TICKET, IMPLEMENT_DIRECTLY, DELEGATE_SUBMIND, NEEDS_HUMAN, WAIT]
    }
    review {
      hasCurrentReview true
      readiness READY
      requiresHumanApproval false
      blockingReasons []
      warnings []
      unansweredQuestions []
      openItemDispositions []
      reviewConfidence 0.94
    }
  }
}

test DecideNextAction_HumanApprovalRequired {
  functions [DecideNextAction]
  args {
    ticket {
      id "issue-3"
      identifier "WK-3"
      title "Clarify compatibility promise"
      description "The ticket needs a product decision."
      labels ["Mastermind Reviewed"]
      status "Todo"
      teamId "team-1"
    }
    project {
      id "weavekit"
      displayName "Weavekit"
      repositoryPath "/tmp/weavekit"
      allowedActions [REVIEW_TICKET, IMPLEMENT_DIRECTLY, DELEGATE_SUBMIND, NEEDS_HUMAN, WAIT]
    }
    review {
      hasCurrentReview true
      readiness BLOCKED
      requiresHumanApproval true
      blockingReasons ["Product owner must choose the compatibility policy."]
      warnings []
      unansweredQuestions ["Which compatibility policy is required?"]
      openItemDispositions [
        {
          kind BLOCKING_REASON
          text "Product owner must choose the compatibility policy."
          owner HUMAN
          rationale "Acceptance behavior cannot be inferred by the executor."
        }
        {
          kind UNANSWERED_QUESTION
          text "Which compatibility policy is required?"
          owner HUMAN
          rationale "Acceptance behavior cannot be inferred by the executor."
        }
      ]
      reviewConfidence 0.89
    }
  }
}

test DecideNextAction_ExecutorPreflightGap {
  functions [DecideNextAction]
  args {
    ticket {
      id "issue-4"
      identifier "WK-4"
      title "Prototype synthesis benchmark"
      description "The package manager and runtime still need verification."
      labels ["Mastermind Reviewed"]
      status "Todo"
      teamId "team-1"
    }
    project {
      id "weavekit"
      displayName "Weavekit"
      repositoryPath "/tmp/weavekit"
      allowedActions [REVIEW_TICKET, IMPLEMENT_DIRECTLY, DELEGATE_SUBMIND, NEEDS_HUMAN, WAIT]
    }
    review {
      hasCurrentReview true
      readiness READY_WITH_NONBLOCKING_GAPS
      requiresHumanApproval false
      blockingReasons []
      warnings ["Verify the local proxy runtime before synthesis benchmarking."]
      unansweredQuestions ["Is the local proxy advertising gemini-3.6-flash in this environment?"]
      openItemDispositions [
        {
          kind UNANSWERED_QUESTION
          text "Is the local proxy advertising gemini-3.6-flash in this environment?"
          owner EXECUTOR_PREFLIGHT
          rationale "The executor can prove the runtime model inventory immediately before work."
        }
      ]
      reviewConfidence 0.87
    }
  }
}

test DecideNextAction_KnownExternalDependency {
  functions [DecideNextAction]
  args {
    ticket {
      id "issue-5"
      identifier "WK-5"
      title "Wait for upstream access"
      description "The task depends on an external system becoming available."
      labels ["Mastermind Reviewed"]
      status "Todo"
      teamId "team-1"
    }
    project {
      id "weavekit"
      displayName "Weavekit"
      repositoryPath "/tmp/weavekit"
      allowedActions [REVIEW_TICKET, IMPLEMENT_DIRECTLY, DELEGATE_SUBMIND, NEEDS_HUMAN, WAIT]
    }
    review {
      hasCurrentReview true
      readiness BLOCKED
      requiresHumanApproval false
      blockingReasons ["The vendor sandbox is currently unavailable to the executor."]
      warnings []
      unansweredQuestions ["When will the vendor sandbox become reachable again?"]
      openItemDispositions [
        {
          kind BLOCKING_REASON
          text "The vendor sandbox is currently unavailable to the executor."
          owner EXTERNAL_DEPENDENCY
          rationale "The executor cannot control the external service and must wait for it."
        }
        {
          kind UNANSWERED_QUESTION
          text "When will the vendor sandbox become reachable again?"
          owner EXTERNAL_DEPENDENCY
          rationale "The executor cannot control the external service and must wait for it."
        }
      ]
      reviewConfidence 0.81
    }
  }
}
