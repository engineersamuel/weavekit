import { describe, expect, it } from "vitest";
import { MastermindHarnessTransport } from "../../src/config.js";
import type { PostImplementationReviewDossier } from "../../src/generated/baml_client/index.js";
import {
  CopilotSdkCodeReviewHarness,
  parseCodeReviewDossier,
} from "../../src/mastermind/codeReview/harness.js";
import { unknownCopilotToolNames } from "../../src/mastermind/harness/toolNames.js";
import type { ExecutionAttempt, StoredReview } from "../../src/mastermind/store/store.js";

const dossier: PostImplementationReviewDossier = {
  summary: "The implementation satisfies the ticket.",
  acceptanceCriteriaCoverage: ["The endpoint verification passed."],
  verificationAssessment: ["The retained evidence is complete."],
  manualVerification: [],
  findings: [],
  knownRisks: [],
  unansweredQuestions: [],
  confidence: 0.95,
};

describe("Copilot SDK code-review harness", () => {
  it("extracts a JSON dossier from surrounding model prose", () => {
    expect(parseCodeReviewDossier(`Review follows:\n${JSON.stringify(dossier)}\nDone.`)).toEqual(
      dossier,
    );
  });

  it("requests one corrected response when the first response is not JSON", async () => {
    const prompts: string[] = [];
    let sessionConfig: unknown;
    let responseIndex = 0;
    const harness = new CopilotSdkCodeReviewHarness(
      {
        transport: MastermindHarnessTransport.COPILOT_SDK,
        command: "copilot",
        args: [],
        model: "test-model",
      },
      async () => ({
        async start() {},
        async createSession(config) {
          sessionConfig = config;
          return {
            async sendAndWait(message) {
              prompts.push(message.prompt);
              responseIndex += 1;
              return {
                data: {
                  content:
                    responseIndex === 1
                      ? "The README and evidence look correct."
                      : JSON.stringify(dossier),
                },
              };
            },
            async disconnect() {},
          };
        },
        async stop() {
          return undefined;
        },
      }),
    );

    await expect(
      harness.review({
        ticket: {
          id: "issue-one",
          identifier: "WK-1",
          title: "Review implementation",
          description: "Verify the implementation.",
          labels: [],
          status: "In Review",
          teamId: "team-one",
        },
        ticketReview: {
          patch: {},
        } as StoredReview,
        attempt: {
          result: { outcome: "succeeded" },
          verification: [],
          executorHandle: { worktreePath: process.cwd() },
        } as unknown as ExecutionAttempt,
      }),
    ).resolves.toEqual(dossier);
    expect(prompts).toHaveLength(2);
    expect(sessionConfig).toMatchObject({
      workingDirectory: process.cwd(),
      availableTools: ["view", "grep", "rg", "glob", "bash"],
    });
    // An availableTools entry naming no registered tool is dropped silently, so a typo removes a
    // capability without any error. Fail here instead.
    expect(
      unknownCopilotToolNames((sessionConfig as { availableTools: string[] }).availableTools),
    ).toEqual([]);
    expect(prompts[0]).toContain(`Canonical review worktree: ${process.cwd()}`);
    expect(prompts[0]).toContain("Do not\nsubstitute the parent source repository");
    expect(prompts[1]).toContain("one JSON object only");
  });
});
