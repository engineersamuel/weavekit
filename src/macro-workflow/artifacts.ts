import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FinalRecommendationReview,
  OpportunityCouncilReview,
  PlanArtifactSummary,
  ProjectBrief,
  SourceAnalysis,
} from "../generated/baml_client/index.js";
import { WorkflowReplayEventKind } from "./types.js";
import type { MacroWorkflowRunStateLike, WorkflowReplayEvent } from "./types.js";
import { assertNoSensitiveMacroWorkflowData, MacroWorkflowStateStore } from "./stateStore.js";
import { renderWorkflowUsageMarkdown } from "./usage.js";

export type MacroWorkflowArtifactPaths = {
  reportPath: string;
  statePath: string;
  eventLogPath: string;
};

export type MacroWorkflowArtifactsInput = {
  outputDir: string;
  state: MacroWorkflowRunStateLike;
  replayEvents?: WorkflowReplayEvent[];
};

export async function writeMacroWorkflowArtifacts(
  input: MacroWorkflowArtifactsInput,
): Promise<MacroWorkflowArtifactPaths> {
  assertNoSensitiveMacroWorkflowData(input);
  await mkdir(input.outputDir, { recursive: true });

  const reportPath = join(input.outputDir, "workflow-report.md");
  const statePath = join(input.outputDir, "workflow-state.json");
  const eventLogPath = join(input.outputDir, "workflow-events.jsonl");
  await writeMacroWorkflowStateArtifact(input.outputDir, input.state);
  await Promise.all(
    input.state.nodeResults
      .filter((result) => result.payload)
      .map((result) =>
        writeFile(
          join(input.outputDir, `${result.nodeId}.payload.json`),
          JSON.stringify(result.payload, null, 2),
          "utf8",
        ),
      ),
  );
  const artifactLines = input.state.nodeResults.flatMap(
    (result) =>
      result.artifacts?.map(
        (artifact) =>
          `- ${result.nodeId} ${artifact.kind}: ${artifact.path} - ${artifact.description}`,
      ) ?? [],
  );
  const workflowArtifactLines = [
    `- Workflow report: ${reportPath}`,
    `- State snapshot: ${statePath}`,
    ...(input.replayEvents ? [`- Replay event log: ${eventLogPath}`] : []),
    ...artifactLines,
  ];
  const payloadArtifactLines = input.state.nodeResults
    .filter((result) => result.payload)
    .map(
      (result) => `- ${result.nodeId}: ${join(input.outputDir, `${result.nodeId}.payload.json`)}`,
    );

  const report = [
    "# Macro Workflow Run Report",
    "",
    `- Plan: ${input.state.currentPlan.id}`,
    `- Objective: ${input.state.objective}`,
    `- Template: ${input.state.templateId}`,
    `- Status: ${input.state.status}`,
    "",
    ...renderSourceToProjectAdvisory(input.state),
    ...renderRouter(input.state),
    "",
    "## Node Results",
    ...(input.state.nodeResults.length === 0
      ? ["No node results recorded."]
      : input.state.nodeResults.map(
          (result) => `- ${result.nodeId}: ${result.status} - ${result.output}`,
        )),
    "",
    ...renderWorkflowUsageMarkdown(input.state.usage),
    "",
    "## Artifacts",
    ...workflowArtifactLines,
    "",
    "## Typed Payloads",
    ...(payloadArtifactLines.length === 0 ? ["No typed payloads recorded."] : payloadArtifactLines),
    "",
    "## Replans",
    ...(input.state.replans.length === 0
      ? ["No replans recorded."]
      : input.state.replans.map((replan) => `- ${replan.failedNodeId}: ${replan.reason}`)),
  ].join("\n");

  await writeFile(reportPath, report, "utf8");
  if (input.replayEvents) {
    await writeWorkflowReplayEventsAtomically(input.outputDir, eventLogPath, input.replayEvents);
  }

  function renderRouter(state: MacroWorkflowRunStateLike): string[] {
    if (state.templateId !== "router") {
      return [];
    }
    const result =
      getPayloadValue<Record<string, unknown>>(state, "report", "routerResult") ??
      getPayloadValue<Record<string, unknown>>(state, "advise-prompt", "routerResult");
    if (!result) {
      return ["## Router", "", "No router result recorded.", ""];
    }
    const primary = asRecord(result.primary);
    const alternatives = readArray(result.alternatives).map(asRecord);
    const handoff = asRecord(primary.handoff);
    return [
      "## Router",
      "",
      `- Primary route: ${readString(primary, "route") || "unknown"}`,
      `- Harness: ${readString(primary, "harness") || "unknown"}`,
      ...(readString(primary, "ability") ? [`- Ability: ${readString(primary, "ability")}`] : []),
      ...(readString(primary, "model") ? [`- Model: ${readString(primary, "model")}`] : []),
      `- Confidence: ${readNumber(primary, "confidence") ?? "n/a"}`,
      ...(readString(primary, "rationale")
        ? [`- Rationale: ${readString(primary, "rationale")}`]
        : []),
      ...(Object.keys(handoff).length > 0
        ? [
            `- Create Worktree eligible: ${readBoolean(handoff, "createWorktreeEligible") ? "yes" : "no"}`,
          ]
        : []),
      "",
      "### Prompt Rewrite",
      "",
      readString(primary, "promptRewrite") || "No prompt rewrite recorded.",
      "",
      "### Alternatives",
      ...(alternatives.length === 0
        ? ["No alternatives recorded."]
        : alternatives.map(
            (alternative, index) =>
              `${index + 1}. **${readString(alternative, "route") || "unknown"}** via ${readString(alternative, "harness") || "unknown"}: ${readString(alternative, "rationale") || "No rationale recorded."}`,
          )),
    ];
  }

  return { reportPath, statePath, eventLogPath };
}

function renderSourceToProjectAdvisory(state: MacroWorkflowRunStateLike): string[] {
  if (state.templateId !== "source-to-project") {
    return [];
  }

  const sourceAnalysis = getPayloadValue<SourceAnalysis>(state, "source-reading", "sourceAnalysis");
  const projectBrief = getPayloadValue<ProjectBrief>(state, "project-research", "projectBrief");
  const councilReview =
    getPayloadValue<OpportunityCouncilReview>(state, "council-review", "councilReview") ??
    getPayloadValue<OpportunityCouncilReview>(state, "opportunity-mapping", "councilInputReview");
  const plans = collectPlanSummaries(state);
  const finalReview = getPayloadValue<FinalRecommendationReview>(
    state,
    "final-recommendation-review",
    "finalRecommendationReview",
  );
  const notification = getPayloadValue<unknown>(
    state,
    "final-recommendation-review",
    "notification",
  );
  const opportunityAcceptances =
    getPayloadValue<unknown[]>(state, "council-review", "opportunityAcceptances") ?? [];

  return [
    "## Advisory Summary",
    "",
    ...(sourceAnalysis
      ? [`- Source: ${sourceAnalysis.title}`, `- Source takeaway: ${sourceAnalysis.summary}`]
      : []),
    ...(projectBrief
      ? [
          `- Target project: ${projectBrief.displayName}`,
          `- Project fit: ${projectBrief.architecture}`,
        ]
      : []),
    ...(finalReview?.status === "rejected"
      ? renderFinalRecommendationRejection(finalReview, notification)
      : plans.length === 0
        ? ["No selected improvement plans were recorded."]
        : [
            ...(finalReview?.status === "accepted"
              ? ["- Final recommendation review: accepted", ""]
              : []),
            ...plans.flatMap((plan, index) => renderPlanRecommendation(plan, index)),
          ]),
    "",
    "## Ranked Opportunities",
    ...(councilReview
      ? renderRankedOpportunities(councilReview, opportunityAcceptances)
      : ["No ranked opportunities recorded."]),
  ];
}

function renderFinalRecommendationRejection(
  review: FinalRecommendationReview,
  notification: unknown,
): string[] {
  const notificationRecord = asRecord(notification);
  const notificationSummary = readString(notificationRecord, "status")
    ? `${readString(notificationRecord, "channel") || "notification"} ${readString(notificationRecord, "status")}${readString(notificationRecord, "error") ? `: ${readString(notificationRecord, "error")}` : ""}`
    : "";
  return [
    "",
    "### Final Recommendation Review: Rejected",
    "",
    review.rejectionReason ?? review.rationale,
    "",
    "**Actionability**",
    "",
    `Actionable: ${review.actionable ? "yes" : "no"}; improves project: ${review.improvesProject ? "yes" : "no"}.`,
    "",
    "**Complexity assessment**",
    "",
    review.complexityAssessment,
    "",
    ...(notificationSummary ? ["**Notification**", "", notificationSummary, ""] : []),
  ];
}

function renderPlanRecommendation(plan: PlanArtifactSummary, index: number): string[] {
  const record = asRecord(plan);
  const recommendation =
    readString(record, "recommendation") || readString(record, "title") || `Plan ${index + 1}`;
  const targetChange = readString(record, "targetChange") || readString(record, "scope");
  const problemSolved = readString(record, "problemSolved");
  const sourceLessonApplied = readString(record, "sourceLessonApplied");
  const expectedUserValue = readString(record, "expectedUserValue");
  const implementationOutline = readStringArray(record, "implementationOutline");
  const validationCommands = readStringArray(record, "validationCommands");
  const risks = readStringArray(record, "risks");

  return [
    "",
    `### Recommendation ${index + 1}: ${readString(record, "title") || recommendation}`,
    "",
    recommendation,
    "",
    ...(targetChange ? ["**What changes**", "", targetChange, ""] : []),
    ...(problemSolved ? ["**Problem solved**", "", problemSolved, ""] : []),
    ...(sourceLessonApplied ? ["**Source lesson applied**", "", sourceLessonApplied, ""] : []),
    ...(expectedUserValue ? ["**Expected value**", "", expectedUserValue, ""] : []),
    ...(implementationOutline.length > 0
      ? ["**Implementation outline**", ...renderList(implementationOutline), ""]
      : []),
    ...(validationCommands.length > 0
      ? ["**Validation**", ...renderList(validationCommands), ""]
      : []),
    ...(risks.length > 0 ? ["**Risks**", ...renderList(risks), ""] : []),
  ];
}

function renderRankedOpportunities(
  review: OpportunityCouncilReview,
  acceptances: unknown[] = [],
): string[] {
  const opportunities = Array.isArray(review.opportunities) ? review.opportunities : [];
  const acceptanceById = new Map<string, Record<string, unknown>>();
  for (const acceptance of acceptances) {
    const record = asRecord(acceptance);
    const id = readString(record, "id");
    if (id) {
      acceptanceById.set(id, record);
    }
  }
  return [
    ...(review.rankingRationale ? [review.rankingRationale, ""] : []),
    ...(opportunities.length === 0
      ? ["No opportunities recorded."]
      : opportunities.map((opportunity, index) => {
          const score = opportunity.score;
          const scoreSummary = score
            ? ` applicability ${formatScore(score.applicability)}, impact ${formatScore(score.impact)}, confidence ${formatScore(score.confidence)}`
            : "";
          const acceptance = acceptanceById.get(opportunity.id);
          const acceptanceSummary = acceptance
            ? `\n   ${readBoolean(acceptance, "accepted") ? "Accepted" : "Rejected"}: ${readString(acceptance, "reason")}`
            : "";
          return `${index + 1}. **${opportunity.title}**${scoreSummary}\n   ${opportunity.projectChange}${acceptanceSummary}`;
        })),
  ];
}

function collectPlanSummaries(state: MacroWorkflowRunStateLike): PlanArtifactSummary[] {
  const plans: PlanArtifactSummary[] = [];
  for (const result of state.nodeResults) {
    const payloadPlans = result.payload?.plans;
    if (Array.isArray(payloadPlans)) {
      plans.push(...(payloadPlans as PlanArtifactSummary[]));
      continue;
    }
    const plan = result.payload?.plan;
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      plans.push(plan as PlanArtifactSummary);
    }
  }
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const key = `${plan.title}:${plan.opportunityIds.join(",")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getPayloadValue<T>(
  state: MacroWorkflowRunStateLike,
  nodeId: string,
  key: string,
): T | undefined {
  return state.nodeResults.find((result) => result.nodeId === nodeId)?.payload?.[key] as
    | T
    | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function renderList(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

export async function writeMacroWorkflowStateArtifact(
  outputDir: string,
  state: MacroWorkflowRunStateLike,
): Promise<string> {
  return new MacroWorkflowStateStore(outputDir).write(state);
}

export async function appendWorkflowReplayEvent(
  outputDir: string,
  event: WorkflowReplayEvent,
): Promise<string> {
  assertNoSensitiveMacroWorkflowData(event, "replayEvent");
  await mkdir(outputDir, { recursive: true });
  const eventLogPath = join(outputDir, "workflow-events.jsonl");
  await appendFile(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
  return eventLogPath;
}

export async function readWorkflowReplayEvents(outputDir: string): Promise<WorkflowReplayEvent[]> {
  const eventLogPath = join(outputDir, "workflow-events.jsonl");
  let contents: string;
  try {
    contents = await readFile(eventLogPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const events: WorkflowReplayEvent[] = [];
  let previousSeq = 0;
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (!line.trim()) {
      continue;
    }
    const event = parseWorkflowReplayEvent(line, index + 1, eventLogPath, previousSeq);
    events.push(event);
    previousSeq = event.seq;
  }
  return events;
}

function parseWorkflowReplayEvent(
  line: string,
  lineNumber: number,
  eventLogPath: string,
  previousSeq: number,
): WorkflowReplayEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw invalidReplayEventError(eventLogPath, lineNumber, "invalid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidReplayEventError(eventLogPath, lineNumber, "expected an object");
  }
  const event = value as Record<string, unknown>;
  if (!Number.isInteger(event.seq) || (event.seq as number) <= previousSeq) {
    throw invalidReplayEventError(
      eventLogPath,
      lineNumber,
      `seq must be an integer greater than ${previousSeq}`,
    );
  }
  if (typeof event.ts !== "string" || Number.isNaN(Date.parse(event.ts))) {
    throw invalidReplayEventError(eventLogPath, lineNumber, "ts must be an ISO date string");
  }
  if (
    typeof event.kind !== "string" ||
    !Object.values(WorkflowReplayEventKind).includes(
      event.kind as (typeof WorkflowReplayEventKind)[keyof typeof WorkflowReplayEventKind],
    )
  ) {
    throw invalidReplayEventError(eventLogPath, lineNumber, "kind is not recognized");
  }
  return value as WorkflowReplayEvent;
}

function invalidReplayEventError(
  eventLogPath: string,
  lineNumber: number,
  reason: string,
  cause?: unknown,
): Error {
  return new Error(
    `Invalid workflow replay event at line ${lineNumber} in ${eventLogPath}: ${reason}.`,
    cause === undefined ? undefined : { cause },
  );
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function formatWorkflowReplayEvents(events: WorkflowReplayEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function writeWorkflowReplayEventsAtomically(
  outputDir: string,
  eventLogPath: string,
  events: WorkflowReplayEvent[],
): Promise<void> {
  const temporaryPath = join(outputDir, `.workflow-events.jsonl.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, formatWorkflowReplayEvents(events), "utf8");
    await rename(temporaryPath, eventLogPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
