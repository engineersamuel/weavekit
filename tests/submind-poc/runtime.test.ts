import { describe, expect, it } from "vitest";
import {
  assertCopilotOrchestratorKind,
  classifyOrchestratorStatus,
  parsePreflightResults,
} from "../../src/submind-poc/runtime.js";

describe("submind runtime", () => {
  it("requires detected orchestrators to report the Copilot kind", () => {
    expect(() => assertCopilotOrchestratorKind(undefined)).toThrow(
      "Wrong detected orchestrator kind",
    );
    expect(() => assertCopilotOrchestratorKind("grok")).toThrow(
      "Wrong detected orchestrator kind: grok",
    );
    expect(() => assertCopilotOrchestratorKind("copilot")).not.toThrow();
  });

  it("ignores preflight statuses embedded in the echoed shell command", () => {
    const marker = "__SUBMIND_PREFLIGHT_94565__";
    const transcript = [
      `type copilot >/dev/null 2>&1 && printf '${marker}copilot=ok\\n' || printf '${marker}copilot=missing\\n'; type grx >/dev/null 2>&1 && printf '${marker}grx=ok\\n' || printf '${marker}grx=missing\\n'; type codx >/dev/null 2>&1 && printf '${marker}codx=ok\\n' || printf '${marker}codx=missing\\n'`,
      `${marker}copilot=ok`,
      `${marker}grx=ok`,
      `${marker}codx=ok`,
      `${marker}trellage=ok`,
    ].join("\n");

    expect(parsePreflightResults(transcript, marker)).toEqual({
      copilot: "ok",
      grx: "ok",
      codx: "ok",
      trellage: "ok",
    });
  });

  it("keeps an idle interactive orchestrator active", () => {
    expect(classifyOrchestratorStatus("idle")).toBe("active");
    expect(classifyOrchestratorStatus("working")).toBe("active");
    expect(classifyOrchestratorStatus("done")).toBe("active");
  });
});
