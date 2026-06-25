import { ClientRegistry } from "@boundaryml/baml";
import { describe, expect, it } from "vitest";
import { toBamlCallOptions } from "../../src/decision-council/bamlRouting.js";

describe("toBamlCallOptions", () => {
  it("returns an empty object when there is no decision", () => {
    expect(toBamlCallOptions(undefined)).toEqual({});
  });

  it("swaps client by name when no effort is requested", () => {
    const options = toBamlCallOptions({
      clientName: "CopilotProxyClaudeHaiku45",
      model: "claude-haiku-4-5",
      rationale: "fast",
    });
    expect(options).toEqual({ client: "CopilotProxyClaudeHaiku45" });
  });

  it("builds a dynamic ClientRegistry when effort and proxy details are present", () => {
    const options = toBamlCallOptions(
      { clientName: "CopilotProxyGpt55", model: "gpt-5.5", reasoningEffort: "high", rationale: "deep" },
      { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" },
    );
    expect(options.clientRegistry).toBeInstanceOf(ClientRegistry);
    expect(options.client).toBeUndefined();
  });

  it("falls back to client-name swap when effort is set but no base url is available", () => {
    const options = toBamlCallOptions(
      { clientName: "CopilotProxyGpt55", model: "gpt-5.5", reasoningEffort: "high", rationale: "deep" },
      {},
    );
    expect(options).toEqual({ client: "CopilotProxyGpt55" });
  });
});
