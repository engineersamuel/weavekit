#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Collector } from "@boundaryml/baml";
import { b } from "../src/generated/baml_client/index.js";
import {
  ReviewOpenItemOwner,
  ReviewReadiness,
  type LinearTicketInput,
  type ProposedLinearTicketPatch,
} from "../src/generated/baml_client/index.js";
import { createMastermindSynthesisClientRegistry } from "../src/mastermind/decision/bamlAdapters.js";
import { validateTicketReviewProposal } from "../src/mastermind/review/policy.js";
import type { LinearTicketSnapshot } from "../src/mastermind/store/store.js";
import {
  MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES,
  type MastermindSynthesisBenchmarkFixture,
} from "../tests/fixtures/mastermind/synthesis/fixtures.js";

export type ParsedBenchmarkArgs = {
  candidateModel?: string;
  baselineModel?: string;
  outputPath?: string;
  help: boolean;
};

export type SynthesisInvocationResult = {
  patch: ProposedLinearTicketPatch;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type FixtureRunReport = {
  fixtureId: string;
  label: string;
  model: string;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  validationAccepted: boolean;
  validationReasons: string[];
  missingFacts: string[];
  readinessMatched: boolean;
  approvalMatched: boolean;
  executorPreflightMatched: boolean;
  externalDependencyMatched: boolean;
  humanOwnedMatched: boolean;
  materialScopeMatched: boolean;
  humanOwnedBecameReady: boolean;
  passed: boolean;
};

export type BenchmarkGateSummary = {
  candidatePolicyPass: boolean;
  candidateFactPass: boolean;
  candidateSemanticPass: boolean;
  candidateHumanSafetyPass: boolean;
  candidateRelativeMedianLatencyPass: boolean;
  candidateBeatsBaselinePass: boolean;
  candidateObservedTargetPass: boolean;
  candidateAdoptionPerformancePass: boolean;
  candidateMaxLatencyPass: boolean;
  baselineQualityPass: boolean;
  passed: boolean;
  failures: string[];
};

export type BenchmarkPolicy = {
  maxRelativeSlowdownRatio: number;
  observedTargetMs: number;
  maxLatencyMs: number;
  minimumBaselineImprovementMs: number;
  invocationOrder: string;
};

export type MastermindSynthesisBenchmarkReport = {
  candidateModel: string;
  baselineModel: string;
  outputPath: string;
  policy: BenchmarkPolicy;
  fixtureCount: number;
  candidateMedianMs: number;
  baselineMedianMs: number;
  candidateResults: FixtureRunReport[];
  baselineResults: FixtureRunReport[];
  gates: BenchmarkGateSummary;
};

type BenchmarkDependencies = {
  invokePatch?: (
    model: string,
    fixture: MastermindSynthesisBenchmarkFixture,
  ) => Promise<SynthesisInvocationResult>;
  writeReport?: boolean;
  outputPath?: string;
};

export const MASTERMIND_SYNTHESIS_BENCHMARK_POLICY: BenchmarkPolicy = {
  maxRelativeSlowdownRatio: 0.1,
  observedTargetMs: 12_000,
  maxLatencyMs: 70_000,
  minimumBaselineImprovementMs: 0,
  invocationOrder:
    "Alternate candidate-first and baseline-first execution by fixture index to counterbalance warmup bias.",
};

export function formatBenchmarkHelp(error?: string): string {
  return [
    ...(error ? [error, ""] : []),
    "Usage: nub scripts/mastermind-synthesis-benchmark.ts --candidate <model> --baseline <model> [--output <path>]",
    "",
    "Compares Mastermind synthesis quality and latency using synthetic governed fixtures.",
    "The command prints a short terminal table plus a JSON report and exits nonzero when any",
    "candidate gate fails or the benchmark cannot run safely.",
  ].join("\n");
}

export function parseBenchmarkArgs(argv: string[]): ParsedBenchmarkArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  let candidateModel: string | undefined;
  let baselineModel: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--candidate") {
      candidateModel = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--baseline") {
      baselineModel = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--output") {
      outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(formatBenchmarkHelp(`Unknown argument: ${value}`));
  }
  if (!candidateModel) {
    throw new Error(formatBenchmarkHelp("Missing --candidate <model>."));
  }
  if (!baselineModel) {
    throw new Error(formatBenchmarkHelp("Missing --baseline <model>."));
  }
  return {
    candidateModel,
    baselineModel,
    outputPath,
    help: false,
  };
}

export async function invokeSynthesisModel(
  model: string,
  fixture: MastermindSynthesisBenchmarkFixture,
): Promise<SynthesisInvocationResult> {
  const collector = new Collector(`mastermind.synthesis-benchmark.${model}.${fixture.id}`);
  const startedAt = Date.now();
  const patch = await b.SynthesizeLinearTicketPatch(
    fixture.ticket,
    fixture.project,
    fixture.dossier,
    {
      collector,
      clientRegistry: createMastermindSynthesisClientRegistry(model),
    },
  );
  return {
    patch,
    elapsedMs: collector.last?.timing?.durationMs ?? Date.now() - startedAt,
    inputTokens: collector.usage?.inputTokens ?? undefined,
    outputTokens: collector.usage?.outputTokens ?? undefined,
  };
}

export function evaluateFixtureRun(args: {
  fixture: MastermindSynthesisBenchmarkFixture;
  model: string;
  result: SynthesisInvocationResult;
}): FixtureRunReport {
  const { fixture, model, result } = args;
  const validation = validateTicketReviewProposal({
    ticket: toLinearTicketSnapshot(fixture.ticket),
    project: fixture.project,
    dossier: fixture.dossier,
    patch: result.patch,
  });
  const searchableText = collectPatchText(result.patch).join("\n").toLowerCase();
  const missingFacts = fixture.requiredFacts.filter(
    (fact) => !searchableText.includes(fact.toLowerCase()),
  );
  const readinessMatched = result.patch.readiness === fixture.expected.readiness;
  const approvalMatched =
    result.patch.requiresHumanApproval === fixture.expected.requiresHumanApproval;
  const executorPreflightMatched = (fixture.expected.openItems ?? [])
    .filter((openItem) => openItem.owner === ReviewOpenItemOwner.EXECUTOR_PREFLIGHT)
    .every((openItem) =>
      result.patch.openItemDispositions.some(
        (disposition) =>
          disposition.kind === openItem.kind &&
          disposition.text.trim() === openItem.text.trim() &&
          disposition.owner === ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
      ),
    );
  const externalDependencyMatched = (fixture.expected.openItems ?? [])
    .filter((openItem) => openItem.owner === ReviewOpenItemOwner.EXTERNAL_DEPENDENCY)
    .every((openItem) =>
      result.patch.openItemDispositions.some(
        (disposition) =>
          disposition.kind === openItem.kind &&
          disposition.text.trim() === openItem.text.trim() &&
          disposition.owner === ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
      ),
    );
  const humanOwnedMatched = (fixture.expected.openItems ?? [])
    .filter((openItem) => openItem.owner === ReviewOpenItemOwner.HUMAN)
    .every((openItem) =>
      result.patch.openItemDispositions.some(
        (disposition) =>
          disposition.kind === openItem.kind &&
          disposition.text.trim() === openItem.text.trim() &&
          disposition.owner === ReviewOpenItemOwner.HUMAN,
      ),
    );
  const materialScopeMatched =
    fixture.expected.materialScopeChange === undefined ||
    result.patch.materialScopeChange === fixture.expected.materialScopeChange;
  const humanOwnedBecameReady =
    (fixture.expected.openItems ?? []).some(
      (openItem) => openItem.owner === ReviewOpenItemOwner.HUMAN,
    ) && result.patch.readiness !== ReviewReadiness.BLOCKED;

  return {
    fixtureId: fixture.id,
    label: fixture.label,
    model,
    elapsedMs: result.elapsedMs,
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    validationAccepted: validation.accepted,
    validationReasons: validation.reasons,
    missingFacts,
    readinessMatched,
    approvalMatched,
    executorPreflightMatched,
    externalDependencyMatched,
    humanOwnedMatched,
    materialScopeMatched,
    humanOwnedBecameReady,
    passed:
      validation.accepted &&
      missingFacts.length === 0 &&
      readinessMatched &&
      approvalMatched &&
      executorPreflightMatched &&
      externalDependencyMatched &&
      humanOwnedMatched &&
      materialScopeMatched &&
      !humanOwnedBecameReady,
  };
}

export function summarizeBenchmarkGates(args: {
  candidateResults: FixtureRunReport[];
  baselineResults: FixtureRunReport[];
}): {
  candidateMedianMs: number;
  baselineMedianMs: number;
  gates: BenchmarkGateSummary;
} {
  const candidateMedianMs = median(args.candidateResults.map((result) => result.elapsedMs));
  const baselineMedianMs = median(args.baselineResults.map((result) => result.elapsedMs));
  const gates: BenchmarkGateSummary = {
    candidatePolicyPass: args.candidateResults.every((result) => result.validationAccepted),
    candidateFactPass: args.candidateResults.every((result) => result.missingFacts.length === 0),
    candidateSemanticPass: args.candidateResults.every(
      (result) =>
        result.readinessMatched &&
        result.approvalMatched &&
        result.executorPreflightMatched &&
        result.externalDependencyMatched &&
        result.humanOwnedMatched &&
        result.materialScopeMatched,
    ),
    candidateHumanSafetyPass: args.candidateResults.every(
      (result) => !result.humanOwnedBecameReady,
    ),
    candidateRelativeMedianLatencyPass:
      candidateMedianMs <=
      Math.round(
        baselineMedianMs * (1 + MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.maxRelativeSlowdownRatio),
      ),
    candidateBeatsBaselinePass: candidateBeatsBaselineMedian(
      candidateMedianMs,
      baselineMedianMs,
      MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.minimumBaselineImprovementMs,
    ),
    candidateObservedTargetPass:
      candidateMedianMs <= MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.observedTargetMs,
    candidateAdoptionPerformancePass: false,
    candidateMaxLatencyPass:
      Math.max(...args.candidateResults.map((result) => result.elapsedMs)) <=
      MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.maxLatencyMs,
    baselineQualityPass: args.baselineResults.every((result) => result.passed),
    passed: false,
    failures: [],
  };
  gates.candidateAdoptionPerformancePass =
    gates.candidateRelativeMedianLatencyPass &&
    gates.candidateObservedTargetPass &&
    gates.candidateBeatsBaselinePass;
  if (!gates.candidatePolicyPass) {
    gates.failures.push("candidate validation or policy gate failed");
  }
  if (!gates.candidateFactPass) {
    gates.failures.push("candidate required-fact preservation gate failed");
  }
  if (!gates.candidateSemanticPass) {
    gates.failures.push("candidate readiness or ownership semantics gate failed");
  }
  if (!gates.candidateHumanSafetyPass) {
    gates.failures.push("candidate allowed a human-owned item to become implementation-ready");
  }
  if (!gates.candidateRelativeMedianLatencyPass) {
    gates.failures.push("candidate median latency exceeded the 10% relative slowdown limit");
  }
  if (!gates.candidateBeatsBaselinePass) {
    gates.failures.push(
      formatBaselineAdoptionFailure(
        MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.minimumBaselineImprovementMs,
      ),
    );
  }
  if (!gates.candidateObservedTargetPass) {
    gates.failures.push(
      `candidate median latency exceeded the ${MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.observedTargetMs}ms observed target`,
    );
  }
  if (!gates.candidateMaxLatencyPass) {
    gates.failures.push(
      `candidate exceeded the ${MASTERMIND_SYNTHESIS_BENCHMARK_POLICY.maxLatencyMs}ms maximum latency gate`,
    );
  }
  if (!gates.baselineQualityPass) {
    gates.failures.push("baseline quality gate failed");
  }
  gates.passed = gates.failures.length === 0;
  return {
    candidateMedianMs,
    baselineMedianMs,
    gates,
  };
}

export async function runMastermindSynthesisBenchmark(
  parsed: ParsedBenchmarkArgs,
  dependencies: BenchmarkDependencies = {},
): Promise<MastermindSynthesisBenchmarkReport> {
  if (parsed.help || !parsed.candidateModel || !parsed.baselineModel) {
    throw new Error("Parsed benchmark args must include candidate and baseline models.");
  }
  const outputPath =
    dependencies.outputPath ??
    parsed.outputPath ??
    join("runs", "mastermind-synthesis-benchmark", `${Date.now()}.json`);
  const invokePatch = dependencies.invokePatch ?? invokeSynthesisModel;
  const candidateResults: FixtureRunReport[] = [];
  const baselineResults: FixtureRunReport[] = [];

  for (const [index, fixture] of MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES.entries()) {
    const invocations =
      index % 2 === 0
        ? [
            { bucket: "candidate" as const, model: parsed.candidateModel },
            { bucket: "baseline" as const, model: parsed.baselineModel },
          ]
        : [
            { bucket: "baseline" as const, model: parsed.baselineModel },
            { bucket: "candidate" as const, model: parsed.candidateModel },
          ];
    for (const invocation of invocations) {
      const result = await invokePatch(invocation.model, fixture);
      const fixtureReport = evaluateFixtureRun({
        fixture,
        model: invocation.model,
        result,
      });
      if (invocation.bucket === "candidate") {
        candidateResults.push(fixtureReport);
      } else {
        baselineResults.push(fixtureReport);
      }
    }
  }

  const { candidateMedianMs, baselineMedianMs, gates } = summarizeBenchmarkGates({
    candidateResults,
    baselineResults,
  });
  const report: MastermindSynthesisBenchmarkReport = {
    candidateModel: parsed.candidateModel,
    baselineModel: parsed.baselineModel,
    outputPath,
    policy: MASTERMIND_SYNTHESIS_BENCHMARK_POLICY,
    fixtureCount: MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES.length,
    candidateMedianMs,
    baselineMedianMs,
    candidateResults,
    baselineResults,
    gates,
  };
  if (dependencies.writeReport !== false) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function collectPatchText(patch: ProposedLinearTicketPatch): string[] {
  return [
    patch.proposedTitle,
    patch.proposedDescriptionMarkdown,
    patch.preservedIntent,
    ...patch.acceptanceCriteria,
    ...patch.assumptions,
    ...patch.ambiguities,
    ...patch.unansweredQuestions,
    ...patch.openItemDispositions.map((disposition) => disposition.text),
    ...patch.dependencies,
    ...patch.risks,
    ...patch.automatedVerification,
    ...patch.manualVerification,
    ...patch.validationSteps,
    ...patch.observability,
    ...patch.rolloutPlan,
    ...patch.rollbackPlan,
    ...patch.outOfScope,
    ...patch.blockingReasons,
    ...patch.warnings,
  ];
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function candidateBeatsBaselineMedian(
  candidateMedianMs: number,
  baselineMedianMs: number,
  minimumBaselineImprovementMs: number,
): boolean {
  return minimumBaselineImprovementMs > 0
    ? candidateMedianMs <= baselineMedianMs - minimumBaselineImprovementMs
    : candidateMedianMs < baselineMedianMs;
}

function formatBaselineAdoptionFailure(minimumBaselineImprovementMs: number): string {
  return minimumBaselineImprovementMs > 0
    ? `candidate median latency did not beat the baseline median by the required ${minimumBaselineImprovementMs}ms minimum for default adoption`
    : "candidate median latency did not beat the baseline median required for default adoption";
}

function toLinearTicketSnapshot(ticket: LinearTicketInput): LinearTicketSnapshot {
  return {
    id: ticket.id,
    identifier: ticket.identifier,
    url: `https://linear.app/synthetic/issue/${ticket.identifier}`,
    title: ticket.title,
    description: ticket.description,
    labels: ticket.labels.map((name, index) => ({ id: `label-${index}`, name })),
    status: ticket.status,
    projectId: ticket.projectId ?? undefined,
    teamId: ticket.teamId,
  };
}

function printBenchmarkSummary(report: MastermindSynthesisBenchmarkReport): void {
  console.table(
    MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES.map((fixture) => {
      const baseline = report.baselineResults.find((result) => result.fixtureId === fixture.id)!;
      const candidate = report.candidateResults.find((result) => result.fixtureId === fixture.id)!;
      return {
        fixture: fixture.id,
        baselineMs: Math.round(baseline.elapsedMs),
        candidateMs: Math.round(candidate.elapsedMs),
        baselinePass: baseline.passed,
        candidatePass: candidate.passed,
      };
    }),
  );
  console.log(JSON.stringify(report, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseBenchmarkArgs(argv);
    if (parsed.help) {
      console.log(formatBenchmarkHelp());
      return;
    }
    const report = await runMastermindSynthesisBenchmark(parsed);
    printBenchmarkSummary(report);
    if (!report.gates.passed) {
      throw new Error(
        `Mastermind synthesis benchmark failed: ${report.gates.failures.join("; ")}.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
