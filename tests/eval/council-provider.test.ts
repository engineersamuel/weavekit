import { CouncilProvider } from "../../src/eval/providers/council.js";
import type { DecisionCouncilReport } from "../../src/index.js";

function fakeReport(overrides: Partial<DecisionCouncilReport> = {}): DecisionCouncilReport {
  return {
    recommendation: "Use A",
    rationale: ["because simple"],
    strongestObjections: ["B scales"],
    unresolvedQuestions: [],
    confidence: 0.8,
    convergence: 0.9,
    nextExperiment: "spike B",
    finalReportMarkdown: "# Report\nUse A.",
    failedPersonas: [],
    ...overrides,
  };
}

describe("CouncilProvider", () => {
  it("maps vars to council input and returns the report markdown", async () => {
    let received: unknown;
    const provider = new CouncilProvider({
      run: async (input, options) => {
        received = { input, options };
        return fakeReport();
      },
    });
    const res = await provider.callApi("ignored", {
      vars: { prompt: "A or B?", contextItems: ["small team"], constraints: ["simple"] },
    });
    expect(received).toEqual({
      input: { prompt: "A or B?", context: ["small team"], constraints: ["simple"] },
      options: { deps: { writeArtifacts: false } },
    });
    expect(res.output).toBe("# Report\nUse A.");
    expect(res.metadata).toMatchObject({ recommendation: "Use A", confidence: 0.8 });
  });

  it("returns an error string when the council throws", async () => {
    const provider = new CouncilProvider({
      run: async () => {
        throw new Error("boom");
      },
    });
    const res = await provider.callApi("ignored", { vars: { prompt: "A or B?" } });
    expect(res.error).toMatch(/boom/);
    expect(res.output).toBeUndefined();
  });
});
