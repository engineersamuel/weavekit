import { describe, expect, it } from "vitest";
import {
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  type ProposedLinearTicketPatch,
} from "../../src/generated/baml_client/index.js";
import {
  formatBenchmarkHelp,
  parseBenchmarkArgs,
  runMastermindSynthesisBenchmark,
  type SynthesisInvocationResult,
} from "../../scripts/mastermind-synthesis-benchmark.js";
import {
  MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES,
  type MastermindSynthesisBenchmarkFixture,
} from "../fixtures/mastermind/synthesis/fixtures.js";

function buildPatchFromFixture(
  fixture: MastermindSynthesisBenchmarkFixture,
  overrides: Partial<ProposedLinearTicketPatch> = {},
): ProposedLinearTicketPatch {
  const openItemDispositions = (fixture.expected.openItems ?? []).map((openItem) => ({
    kind: openItem.kind,
    text: openItem.text,
    owner: openItem.owner,
    rationale:
      openItem.owner === ReviewOpenItemOwner.EXECUTOR_PREFLIGHT
        ? "Executor preflight can verify this immediately before work starts."
        : openItem.owner === ReviewOpenItemOwner.EXTERNAL_DEPENDENCY
          ? "The executor cannot control this prerequisite and must wait for it."
          : "A human owner must resolve this before implementation starts.",
  }));
  const unansweredQuestions = openItemDispositions
    .filter((disposition) => disposition.kind === ReviewOpenItemKind.UNANSWERED_QUESTION)
    .map((disposition) => disposition.text);
  const blockingReasons = openItemDispositions
    .filter((disposition) => disposition.kind === ReviewOpenItemKind.BLOCKING_REASON)
    .map((disposition) => disposition.text);
  return {
    proposedTitle: fixture.ticket.title,
    proposedDescriptionMarkdown: fixture.requiredFacts.join("\n"),
    ticketKind: fixture.dossier.ticketKind,
    preservedIntent: fixture.dossier.preservedIntent,
    acceptanceCriteria:
      fixture.dossier.suggestedAcceptanceCriteria.length > 0
        ? fixture.dossier.suggestedAcceptanceCriteria
        : ["Synthetic acceptance criteria"],
    assumptions: fixture.dossier.assumptions,
    ambiguities: fixture.dossier.ambiguities,
    unansweredQuestions,
    openItemDispositions,
    dependencies: fixture.dossier.dependencies,
    risks: fixture.dossier.risks,
    automatedVerification: fixture.dossier.automatedVerification,
    manualVerification: fixture.dossier.manualVerification,
    validationSteps: fixture.dossier.validationSteps,
    observability: fixture.dossier.observability,
    rolloutPlan: fixture.dossier.rolloutPlan,
    rollbackPlan: fixture.dossier.rollbackPlan,
    outOfScope: fixture.dossier.outOfScope,
    evidence: fixture.dossier.repositoryEvidence,
    readiness: fixture.expected.readiness,
    blockingReasons,
    warnings:
      fixture.expected.readiness === "READY_WITH_NONBLOCKING_GAPS"
        ? ["Verify the executor preflight requirement before implementation starts."]
        : [],
    materialScopeChange: fixture.expected.materialScopeChange ?? false,
    requiresHumanApproval: fixture.expected.requiresHumanApproval,
    confidence: 0.93,
    ...overrides,
  };
}

describe("mastermind synthesis benchmark", () => {
  it("documents candidate and baseline arguments without running a model call", () => {
    expect(parseBenchmarkArgs(["--help"])).toEqual({ help: true });
    expect(formatBenchmarkHelp()).toContain("--candidate <model>");
    expect(formatBenchmarkHelp()).toContain("--baseline <model>");
  });

  it("evaluates synthetic benchmark fixtures with a fake invoker", async () => {
    const report = await runMastermindSynthesisBenchmark(
      parseBenchmarkArgs(["--candidate", "gemini-3.6-flash", "--baseline", "gpt-5.5"]),
      {
        outputPath: "runs/mastermind-synthesis-benchmark/test-report.json",
        writeReport: false,
        invokePatch: async (model, fixture): Promise<SynthesisInvocationResult> => ({
          patch: buildPatchFromFixture(fixture),
          elapsedMs: model === "gemini-3.6-flash" ? 12_000 : 40_000,
          inputTokens: 1000,
          outputTokens: 400,
        }),
      },
    );

    expect(report.fixtureCount).toBe(MASTERMIND_SYNTHESIS_BENCHMARK_FIXTURES.length);
    expect(report.gates).toMatchObject({
      candidatePolicyPass: true,
      candidateFactPass: true,
      candidateSemanticPass: true,
      candidateHumanSafetyPass: true,
      candidateRelativeMedianLatencyPass: true,
      candidateBeatsBaselinePass: true,
      candidateObservedTargetPass: true,
      candidateAdoptionPerformancePass: true,
      candidateMaxLatencyPass: true,
      baselineQualityPass: true,
      passed: true,
    });
  });

  it("fails the benchmark when a candidate makes a human-owned item implementation-ready", async () => {
    const report = await runMastermindSynthesisBenchmark(
      parseBenchmarkArgs(["--candidate", "gemini-3.6-flash", "--baseline", "gpt-5.5"]),
      {
        outputPath: "runs/mastermind-synthesis-benchmark/test-report-failing.json",
        writeReport: false,
        invokePatch: async (model, fixture): Promise<SynthesisInvocationResult> => {
          if (model === "gemini-3.6-flash" && fixture.id === "human-owned-acceptance-question") {
            return {
              patch: buildPatchFromFixture(fixture, {
                readiness: ReviewReadiness.READY,
                requiresHumanApproval: false,
                unansweredQuestions: [],
                openItemDispositions: [],
                blockingReasons: [],
              }),
              elapsedMs: 12_000,
            };
          }
          return {
            patch: buildPatchFromFixture(fixture),
            elapsedMs: model === "gemini-3.6-flash" ? 12_000 : 40_000,
          };
        },
      },
    );

    expect(report.gates.passed).toBe(false);
    expect(report.gates.failures).toContain(
      "candidate readiness or ownership semantics gate failed",
    );
    expect(report.gates.failures).toContain(
      "candidate allowed a human-owned item to become implementation-ready",
    );
  });

  it("does not adopt a slower candidate even when it stays under the observed target", async () => {
    const report = await runMastermindSynthesisBenchmark(
      parseBenchmarkArgs(["--candidate", "gemini-3.6-flash", "--baseline", "gpt-5.5"]),
      {
        outputPath: "runs/mastermind-synthesis-benchmark/test-report-under-target-slower.json",
        writeReport: false,
        invokePatch: async (model, fixture): Promise<SynthesisInvocationResult> => ({
          patch: buildPatchFromFixture(fixture),
          elapsedMs: model === "gemini-3.6-flash" ? 8_500 : 8_000,
        }),
      },
    );

    expect(report.gates.passed).toBe(false);
    expect(report.gates.candidateRelativeMedianLatencyPass).toBe(true);
    expect(report.gates.candidateObservedTargetPass).toBe(true);
    expect(report.gates.candidateBeatsBaselinePass).toBe(false);
    expect(report.gates.candidateAdoptionPerformancePass).toBe(false);
    expect(report.gates.failures).toContain(
      "candidate median latency did not beat the baseline median required for default adoption",
    );
  });

  it("alternates candidate and baseline execution order across fixtures", async () => {
    const calls: string[] = [];

    await runMastermindSynthesisBenchmark(
      parseBenchmarkArgs(["--candidate", "gemini-3.6-flash", "--baseline", "gpt-5.5"]),
      {
        outputPath: "runs/mastermind-synthesis-benchmark/test-report-order.json",
        writeReport: false,
        invokePatch: async (model, fixture): Promise<SynthesisInvocationResult> => {
          calls.push(`${fixture.id}:${model}`);
          return {
            patch: buildPatchFromFixture(fixture),
            elapsedMs: model === "gemini-3.6-flash" ? 9_000 : 10_000,
          };
        },
      },
    );

    expect(calls).toEqual([
      "ready-existing-repository:gemini-3.6-flash",
      "ready-existing-repository:gpt-5.5",
      "greenfield-prototype:gpt-5.5",
      "greenfield-prototype:gemini-3.6-flash",
      "executor-preflight-gap:gemini-3.6-flash",
      "executor-preflight-gap:gpt-5.5",
      "external-dependency-wait:gpt-5.5",
      "external-dependency-wait:gemini-3.6-flash",
      "human-owned-acceptance-question:gemini-3.6-flash",
      "human-owned-acceptance-question:gpt-5.5",
      "blocked-scope-authorization-change:gpt-5.5",
      "blocked-scope-authorization-change:gemini-3.6-flash",
    ]);
  });

  it("fails adoption when the candidate is materially slower than the baseline", async () => {
    const report = await runMastermindSynthesisBenchmark(
      parseBenchmarkArgs(["--candidate", "gemini-3.6-flash", "--baseline", "gpt-5.5"]),
      {
        outputPath: "runs/mastermind-synthesis-benchmark/test-report-slower.json",
        writeReport: false,
        invokePatch: async (model, fixture): Promise<SynthesisInvocationResult> => ({
          patch: buildPatchFromFixture(fixture),
          elapsedMs: model === "gemini-3.6-flash" ? 12_000 : 10_000,
        }),
      },
    );

    expect(report.gates.passed).toBe(false);
    expect(report.gates.candidateRelativeMedianLatencyPass).toBe(false);
    expect(report.gates.candidateObservedTargetPass).toBe(true);
    expect(report.gates.candidateBeatsBaselinePass).toBe(false);
    expect(report.gates.candidateAdoptionPerformancePass).toBe(false);
    expect(report.gates.failures).toContain(
      "candidate median latency exceeded the 10% relative slowdown limit",
    );
    expect(report.gates.failures).toContain(
      "candidate median latency did not beat the baseline median required for default adoption",
    );
  });
});
