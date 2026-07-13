import { describe, expect, it } from "vitest";
import {
  buildImplementationReviewPrompt,
  parseImplementationReviewVerdict,
} from "../../../src/macro-workflow/sourceToProject/implementationReview.js";

describe("implementation review", () => {
  it("renders the initial implementation review prompt", async () => {
    const prompt = await buildImplementationReviewPrompt({
      implementationSummary: "Implemented the accepted source-to-project change.",
      verificationSummary: "All configured validation commands passed.",
    });

    expect(prompt).toContain("Review the current worktree");
    expect(prompt).toContain('status: "accepted" or "needs_changes"');
    expect(prompt).toContain("blockingFindings");
    expect(prompt).toContain("All configured validation commands passed.");
  });

  it("renders the prior verdict in the one allowed re-review prompt", async () => {
    const prompt = await buildImplementationReviewPrompt({
      implementationSummary: "Applied the requested fixes.",
      verificationSummary: "The validation suite passed after fixes.",
      priorVerdict: {
        status: "needs_changes",
        blockingFindings: ["The migration lacks a rollback test."],
        rationale: "Rollback behavior is not verified.",
      },
    });

    expect(prompt).toContain("The migration lacks a rollback test.");
    expect(prompt).toContain("verify that every prior blocking finding is resolved");
  });

  it("parses accepted and needs_changes verdicts", () => {
    const accepted = parseImplementationReviewVerdict(
      JSON.stringify({
        status: "accepted",
        blockingFindings: [],
        rationale: "The implementation is correct and verified.",
      }),
    );
    const needsChanges = parseImplementationReviewVerdict(
      JSON.stringify({
        status: "needs_changes",
        blockingFindings: ["The migration lacks a rollback test."],
        rationale: "Rollback behavior is not verified.",
      }),
    );

    expect(accepted.status).toBe("accepted");
    expect(needsChanges.status).toBe("needs_changes");
  });

  it("rejects contradictory verdicts", () => {
    expect(() =>
      parseImplementationReviewVerdict(
        JSON.stringify({
          status: "accepted",
          blockingFindings: ["The migration lacks a rollback test."],
          rationale: "Rollback behavior is not verified.",
        }),
      ),
    ).toThrow("accepted verdict cannot contain blocking findings");

    expect(() =>
      parseImplementationReviewVerdict(
        JSON.stringify({
          status: "needs_changes",
          blockingFindings: [],
          rationale: "The implementation needs changes.",
        }),
      ),
    ).toThrow("needs_changes verdict must contain blocking findings");
  });

  it("rejects needs_changes verdicts with blank blocking findings", () => {
    for (const blockingFindings of [[""], ["   "], ["A real defect.", "   "]]) {
      expect(() =>
        parseImplementationReviewVerdict(
          JSON.stringify({
            status: "needs_changes",
            blockingFindings,
            rationale: "The implementation needs changes.",
          }),
        ),
      ).toThrow("needs_changes verdict must contain blocking findings");
    }
  });
});
