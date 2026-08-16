import { afterEach, describe, expect, it } from "vitest";
import { buildRlmResumeReceipt } from "../../src/rlm-poc/output.js";

const originalProjectId = process.env.LANGFUSE_PROJECT_ID;
const originalBaseUrl = process.env.LANGFUSE_BASE_URL;

afterEach(() => {
  restoreEnvironment("LANGFUSE_PROJECT_ID", originalProjectId);
  restoreEnvironment("LANGFUSE_BASE_URL", originalBaseUrl);
});

describe("buildRlmResumeReceipt", () => {
  it("prints the conversation ID, a copyable follow-up command, and the trace link", () => {
    const conversationId = "f13c1665-bc2c-4d97-9c37-8f31d5c87d17";
    process.env.LANGFUSE_PROJECT_ID = "project-one";
    process.env.LANGFUSE_BASE_URL = "http://localhost:3000/";

    expect(buildRlmResumeReceipt(conversationId, "trace-one")).toBe(
      [
        "",
        `Conversation ID: ${conversationId}`,
        "Resume conversation:",
        `nub scripts/rlm-poc.ts --resume '${conversationId}' --prompt '<follow-up>'`,
        "Langfuse trace: http://localhost:3000/project/project-one/traces/trace-one",
        "",
      ].join("\n"),
    );
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
