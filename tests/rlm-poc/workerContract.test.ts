import { describe, expect, it, vi } from "vitest";
import {
  RlmVerificationOutcome,
  RlmWorkerOutcome,
  type RlmDependencyReport,
  type RlmRunBrief,
} from "../../src/generated/baml_client/index.js";
import {
  bamlRlmWorkerContract,
  formatRlmWorkerReportText,
  resolveRlmRunBrief,
  type RlmWorkerContract,
} from "../../src/rlm-poc/workerContract.js";

const derivedBrief: RlmRunBrief = {
  objective: "Derived objective.",
  constraints: ["Derived constraint."],
  acceptanceCriteria: ["Derived criterion."],
  validationCommands: ["nub run derived"],
};

function stubContract(deriveBrief?: RlmWorkerContract["deriveBrief"]): RlmWorkerContract {
  return {
    async renderPrompt() {
      return "unused";
    },
    parseResponse() {
      throw new Error("unused");
    },
    ...(deriveBrief ? { deriveBrief } : {}),
  };
}

describe("RLM worker contract", () => {
  it("renders one user prompt with the brief, delegated task, dependencies, and output guidance", async () => {
    const brief: RlmRunBrief = {
      objective: "Ship the worker contract BAML surface.",
      constraints: ["Do not touch user-dirty files.", "Keep the scope bounded."],
      acceptanceCriteria: [
        "Prompt must include the delegated task.",
        "Report must stay evidence-based.",
      ],
      validationCommands: [
        "nub run baml-generate",
        "nub run test -- tests/rlm-poc/workerContract.test.ts",
      ],
    };
    const dependencies: RlmDependencyReport[] = [
      {
        callId: "call-17",
        profile: "research",
        report: {
          outcome: RlmWorkerOutcome.COMPLETED,
          summary: "Cataloged the required contract fields.",
          evidence: [{ id: "e-1", source: "plan.md", quote: "Use the approved contract fields." }],
          artifacts: [{ locator: "docs/plan.md", description: "Approved plan excerpt." }],
          verification: [
            {
              commandOrMethod: "Manual review",
              outcome: RlmVerificationOutcome.NOT_RUN,
              summary: "No command was required for the planning note.",
            },
          ],
          decisions: ["Reuse the shared EvidenceReference contract."],
          risks: ["The final prompt can drift if the schema changes."],
          openQuestions: ["Should integrations display artifacts or only summary text?"],
          remainingWork: ["Implement the renderer and parser wrapper."],
        },
      },
    ];

    const prompt = await bamlRlmWorkerContract.renderPrompt({
      brief,
      delegatedTask: "Write the worker contract adapter and keep it offline-testable.",
      dependencies,
    });

    expect(prompt).toContain("Ship the worker contract BAML surface.");
    expect(prompt).toContain("Do not touch user-dirty files.");
    expect(prompt).toContain("Keep the scope bounded.");
    expect(prompt).toContain("Prompt must include the delegated task.");
    expect(prompt).toContain("Report must stay evidence-based.");
    expect(prompt).toContain("nub run baml-generate");
    expect(prompt).toContain("Write the worker contract adapter and keep it offline-testable.");
    expect(prompt).toContain("Only the supplied dependency reports are available.");
    expect(prompt).toContain("call-17");
    expect(prompt).toContain("Cataloged the required contract fields.");
    expect(prompt).toContain("Reuse the shared EvidenceReference contract.");
    expect(prompt).toContain("outcome");
    expect(prompt).toContain("remainingWork");
  });

  it("parses a valid worker report into generated enum values", () => {
    const report = bamlRlmWorkerContract.parseResponse(
      JSON.stringify({
        outcome: "COMPLETED",
        summary: "Implemented the bounded worker contract.",
        evidence: [
          { id: "e-7", source: "src/rlm-poc/workerContract.ts", quote: "parseResponse(raw)" },
        ],
        artifacts: [
          { locator: "src/rlm-poc/workerContract.ts", description: "Runtime adapter." },
          { locator: "tests/rlm-poc/workerContract.test.ts", description: "Offline coverage." },
        ],
        verification: [
          {
            commandOrMethod: "nub run test -- tests/rlm-poc/workerContract.test.ts",
            outcome: "PASSED",
            summary: "Targeted worker contract tests passed.",
          },
        ],
        decisions: ["Keep prompt extraction strict."],
        risks: ["Generated prompt format can change in a later BAML version."],
        openQuestions: [],
        remainingWork: [],
      }),
    );

    expect(report.outcome).toBe(RlmWorkerOutcome.COMPLETED);
    expect(report.verification[0]?.outcome).toBe(RlmVerificationOutcome.PASSED);
    expect(report.artifacts[0]?.locator).toBe("src/rlm-poc/workerContract.ts");
    expect(formatRlmWorkerReportText(report)).toBe("Implemented the bounded worker contract.");
  });

  it("throws on invalid raw output", () => {
    expect(() =>
      bamlRlmWorkerContract.parseResponse(
        JSON.stringify({
          outcome: "MAYBE",
          summary: "invalid",
          evidence: [],
          artifacts: [],
          verification: [],
          decisions: [],
          risks: [],
          openQuestions: [],
          remainingWork: [],
        }),
      ),
    ).toThrow();
  });
});

describe("RLM run brief resolution", () => {
  it("binds the derived constraints, acceptance criteria, and validation commands", async () => {
    const brief = await resolveRlmRunBrief(
      "Raw objective.",
      stubContract(async () => derivedBrief),
    );

    expect(brief).toEqual(derivedBrief);
  });

  it("replaces only the overridden fields and keeps the rest derived", async () => {
    const brief = await resolveRlmRunBrief(
      "Raw objective.",
      stubContract(async () => derivedBrief),
      { acceptanceCriteria: ["Operator criterion."] },
    );

    expect(brief.acceptanceCriteria).toEqual(["Operator criterion."]);
    expect(brief.constraints).toEqual(["Derived constraint."]);
    expect(brief.validationCommands).toEqual(["nub run derived"]);
  });

  it("skips derivation when every list is overridden", async () => {
    const deriveBrief = vi.fn(async () => derivedBrief);

    const brief = await resolveRlmRunBrief("Raw objective.", stubContract(deriveBrief), {
      constraints: [],
      acceptanceCriteria: ["Operator criterion."],
      validationCommands: ["nub run test"],
    });

    expect(deriveBrief).not.toHaveBeenCalled();
    expect(brief.objective).toBe("Raw objective.");
    expect(brief.acceptanceCriteria).toEqual(["Operator criterion."]);
  });

  it("falls back to the objective-only brief when derivation fails", async () => {
    const errors: string[] = [];

    const brief = await resolveRlmRunBrief(
      "Raw objective.",
      stubContract(async () => {
        throw new Error("proxy unavailable");
      }),
      {},
      (message) => errors.push(message),
    );

    expect(brief).toEqual({
      objective: "Raw objective.",
      constraints: [],
      acceptanceCriteria: [],
      validationCommands: [],
    });
    expect(errors[0]).toContain("proxy unavailable");
  });

  it("keeps the objective-only brief when the contract cannot derive one", async () => {
    const brief = await resolveRlmRunBrief("Raw objective.", stubContract());

    expect(brief.objective).toBe("Raw objective.");
    expect(brief.acceptanceCriteria).toEqual([]);
  });
});
