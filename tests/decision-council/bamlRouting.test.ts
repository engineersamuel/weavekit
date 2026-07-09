import { ClientRegistry } from "@boundaryml/baml";
import { describe, expect, it } from "vitest";
import {
  resolveBamlEffortModel,
  toBamlCallOptions,
} from "../../src/decision-council/bamlRouting.js";

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
      {
        clientName: "CopilotProxyGpt55",
        model: "gpt-5.5",
        reasoningEffort: "high",
        rationale: "deep",
      },
      { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" },
    );
    expect(options.clientRegistry).toBeInstanceOf(ClientRegistry);
    expect(options.client).toBeUndefined();
  });

  it("falls back to client-name swap when effort is set but no base url is available", () => {
    const options = toBamlCallOptions(
      {
        clientName: "CopilotProxyGpt55",
        model: "gpt-5.5",
        reasoningEffort: "high",
        rationale: "deep",
      },
      {},
    );
    expect(options).toEqual({ client: "CopilotProxyGpt55" });
  });

  it("derives the effort model from the validated client, ignoring a hallucinated decision.model", () => {
    expect(
      resolveBamlEffortModel({
        clientName: "CopilotProxyClaudeHaiku45",
        model: "HALLUCINATED-DOES-NOT-EXIST",
        rationale: "",
      }),
    ).toBe("claude-haiku-4-5");
  });

  it("resolves no effort model for an unknown client so no untrusted model can reach the proxy", () => {
    expect(
      resolveBamlEffortModel({ clientName: "CopilotProxyHallucinated", model: "x", rationale: "" }),
    ).toBeUndefined();
  });

  it("does not build an effort registry for an unknown client even when effort + base url are present", () => {
    const options = toBamlCallOptions(
      {
        clientName: "CopilotProxyHallucinated",
        model: "x",
        reasoningEffort: "high",
        rationale: "",
      },
      { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" },
    );
    expect(options.clientRegistry).toBeUndefined();
    expect(options).toEqual({ client: "CopilotProxyHallucinated" });
  });
});
