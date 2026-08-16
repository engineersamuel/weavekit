import { afterEach, describe, expect, it } from "vitest";
import type { SubmindRunState } from "../../src/submind-poc/contracts.js";
import { buildSubmindRunFooter } from "../../src/submind-poc/output.js";

const originalProjectId = process.env.LANGFUSE_PROJECT_ID;
const originalBaseUrl = process.env.LANGFUSE_BASE_URL;

afterEach(() => {
  restoreEnvironment("LANGFUSE_PROJECT_ID", originalProjectId);
  restoreEnvironment("LANGFUSE_BASE_URL", originalBaseUrl);
});

describe("buildSubmindRunFooter", () => {
  it("prints an attach command and direct Langfuse trace link", () => {
    process.env.LANGFUSE_PROJECT_ID = "project-one";
    process.env.LANGFUSE_BASE_URL = "http://localhost:3000/";

    expect(buildSubmindRunFooter(runState(), "trace-one")).toBe(
      [
        "",
        "Resume conversation: herdr agent attach 'submind-run-one-orchestrator'",
        "Langfuse trace: http://localhost:3000/project/project-one/traces/trace-one",
        "",
      ].join("\n"),
    );
  });

  it("still explains how to obtain a direct link when the project ID is unavailable", () => {
    delete process.env.LANGFUSE_PROJECT_ID;

    expect(buildSubmindRunFooter(runState(), "trace-one")).toContain(
      "Langfuse trace: trace-one (set LANGFUSE_PROJECT_ID to print a direct URL)",
    );
  });
});

function runState(): SubmindRunState {
  return {
    schemaVersion: 1,
    runId: "run-one",
    state: "orchestrating",
    sourceRepositoryPath: "/source",
    branchName: "submind/poc-run-one",
    runDirectory: "/control/.weavekit/submind-poc/run-one",
    agentPrefix: "submind-run-one-",
    orchestratorAgentId: "agent-one",
    createdAt: "2026-08-11T19:00:00.000Z",
    updatedAt: "2026-08-11T19:01:00.000Z",
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
