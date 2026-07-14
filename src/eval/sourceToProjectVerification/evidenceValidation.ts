import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../generated/baml_client/types.js";

export type AbsoluteEvidenceIssue = {
  error: string;
  defect: AbsoluteEvidenceDefect;
};

export const AbsoluteEvidenceDefectCode = {
  REQUIRED_EVIDENCE_MISSING: "required-evidence-missing",
  BLANK_QUOTE: "blank-quote",
  QUOTE_NOT_IN_PLAN: "quote-not-in-plan",
} as const;

export type AbsoluteEvidenceDefectCode =
  (typeof AbsoluteEvidenceDefectCode)[keyof typeof AbsoluteEvidenceDefectCode];

type AbsoluteEvidenceDefect = {
  target: "requirement" | "criterion";
  assessmentIndex: number;
  quoteIndex?: number;
  code: AbsoluteEvidenceDefectCode;
};

export type AbsoluteEvidenceRepairSummary = {
  validationFeedback: string;
  evidenceDefectCount: number;
  evidenceDefectCodes: AbsoluteEvidenceDefectCode[];
  evidenceDefectOmittedCount: number;
};

const MAX_RETRY_ISSUES = 32;
const MAX_RETRY_FEEDBACK_CHARACTERS = 2_048;

export function validateAbsoluteJudgeEvidence(args: {
  judgeId: string;
  planMarkdown: string;
  result: SourceToProjectPlanJudgment;
}): AbsoluteEvidenceIssue[] {
  const issues: AbsoluteEvidenceIssue[] = [];
  for (const [assessmentIndex, assessment] of args.result.requirementAssessments.entries()) {
    const subject = `requirement ${assessment.requirementId}`;
    if (assessment.status !== "missing" && !assessment.evidenceQuotes.some(hasNonblankContent)) {
      issues.push({
        error: `${args.judgeId}: ${subject} with status ${assessment.status} requires evidence.`,
        defect: {
          target: "requirement",
          assessmentIndex,
          code: AbsoluteEvidenceDefectCode.REQUIRED_EVIDENCE_MISSING,
        },
      });
    }
    issues.push(
      ...validateQuotes({
        judgeId: args.judgeId,
        subject,
        target: "requirement",
        assessmentIndex,
        quotes: assessment.evidenceQuotes,
        planMarkdown: args.planMarkdown,
      }),
    );
  }
  for (const [assessmentIndex, assessment] of args.result.criterionAssessments.entries()) {
    const subject = `criterion ${assessment.criterion}`;
    if (assessment.score > 0 && !assessment.evidenceQuotes.some(hasNonblankContent)) {
      issues.push({
        error: `${args.judgeId}: ${subject} with score ${assessment.score} requires evidence.`,
        defect: {
          target: "criterion",
          assessmentIndex,
          code: AbsoluteEvidenceDefectCode.REQUIRED_EVIDENCE_MISSING,
        },
      });
    }
    issues.push(
      ...validateQuotes({
        judgeId: args.judgeId,
        subject,
        target: "criterion",
        assessmentIndex,
        quotes: assessment.evidenceQuotes,
        planMarkdown: args.planMarkdown,
      }),
    );
  }
  return issues;
}

export function validateAbsoluteJudgeResult(args: {
  judgeId: string;
  planMarkdown: string;
  expectedRequirementIds: string[];
  expectedCriterionIds: string[];
  result: SourceToProjectPlanJudgment;
}): string[] {
  const errors = validateAssessmentIds({
    judgeId: args.judgeId,
    subject: "requirement",
    expectedIds: args.expectedRequirementIds,
    actualIds: args.result.requirementAssessments.map((assessment) => assessment.requirementId),
  });
  errors.push(
    ...validateAssessmentIds({
      judgeId: args.judgeId,
      subject: "criterion",
      expectedIds: args.expectedCriterionIds,
      actualIds: args.result.criterionAssessments.map((assessment) => assessment.criterion),
    }),
  );
  for (const assessment of args.result.criterionAssessments) {
    if (!Number.isInteger(assessment.score) || assessment.score < 0 || assessment.score > 4) {
      errors.push(
        `${args.judgeId}: criterion ${assessment.criterion} score must be an integer from 0 to 4.`,
      );
    }
  }
  errors.push(...validateAbsoluteJudgeEvidence(args).map((issue) => issue.error));
  return errors;
}

export function validatePairwiseJudgeBounds(args: {
  judgeId: string;
  result: SourceToProjectPairwiseJudgment;
}): string[] {
  if (
    Number.isFinite(args.result.confidence) &&
    args.result.confidence >= 0 &&
    args.result.confidence <= 1
  ) {
    return [];
  }
  return [
    `${args.judgeId}: pairwise confidence must be between 0 and 1; received ${args.result.confidence}.`,
  ];
}

export function summarizeAbsoluteEvidenceIssues(
  issues: AbsoluteEvidenceIssue[],
): AbsoluteEvidenceRepairSummary {
  let included = issues.slice(0, MAX_RETRY_ISSUES);
  while (true) {
    const omittedCount = issues.length - included.length;
    const validationFeedback = [
      ...included.map((issue) => defectDescriptor(issue.defect)),
      ...(omittedCount > 0 ? [`omitted-count: ${omittedCount}`] : []),
    ].join("\n");
    if (validationFeedback.length <= MAX_RETRY_FEEDBACK_CHARACTERS) {
      return {
        validationFeedback,
        evidenceDefectCount: issues.length,
        evidenceDefectCodes: included.map((issue) => issue.defect.code),
        evidenceDefectOmittedCount: omittedCount,
      };
    }
    included = included.slice(0, -1);
  }
}

function validateQuotes(args: {
  judgeId: string;
  subject: string;
  target: AbsoluteEvidenceDefect["target"];
  assessmentIndex: number;
  quotes: string[];
  planMarkdown: string;
}): AbsoluteEvidenceIssue[] {
  return args.quotes.flatMap<AbsoluteEvidenceIssue>((quote, quoteIndex) => {
    if (!hasNonblankContent(quote)) {
      return [
        {
          error: `${args.judgeId}: ${args.subject} evidence quote is empty.`,
          defect: {
            target: args.target,
            assessmentIndex: args.assessmentIndex,
            quoteIndex,
            code: AbsoluteEvidenceDefectCode.BLANK_QUOTE,
          },
        },
      ];
    }
    if (args.planMarkdown.includes(quote)) return [];
    return [
      {
        error: `${args.judgeId}: ${args.subject} evidence quote is not in the plan.`,
        defect: {
          target: args.target,
          assessmentIndex: args.assessmentIndex,
          quoteIndex,
          code: AbsoluteEvidenceDefectCode.QUOTE_NOT_IN_PLAN,
        },
      },
    ];
  });
}

function validateAssessmentIds(args: {
  judgeId: string;
  subject: "requirement" | "criterion";
  expectedIds: string[];
  actualIds: string[];
}): string[] {
  const errors = duplicates(args.actualIds).map(
    (id) => `${args.judgeId}: duplicate ${args.subject} ${id}.`,
  );
  const expected = new Set(args.expectedIds);
  for (const id of unique(args.actualIds)) {
    if (!expected.has(id)) errors.push(`${args.judgeId}: unknown ${args.subject} ${id}.`);
  }
  for (const id of expected) {
    if (!args.actualIds.includes(id))
      errors.push(`${args.judgeId}: missing ${args.subject} ${id}.`);
  }
  return errors;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function defectDescriptor(defect: AbsoluteEvidenceDefect): string {
  const quote = defect.quoteIndex === undefined ? "" : `.quote[${defect.quoteIndex}]`;
  return `${defect.target}[${defect.assessmentIndex}]${quote}: ${defect.code}`;
}

function hasNonblankContent(value: string): boolean {
  return value.trim().length > 0;
}
