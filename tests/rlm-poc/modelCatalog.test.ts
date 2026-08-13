import { describe, expect, it } from "vitest";
import {
  RlmModelGroup,
  parseCopilotModelCatalog,
  resolveRlmModelCandidates,
  resolveRlmModelDecision,
} from "../../src/rlm-poc/modelCatalog.js";

const RAW_CATALOG = {
  generated_at: "2026-08-12T00:00:00Z",
  groups: {
    "frontier-current": ["opus", "sol"],
    "balanced-workhorse": ["sonnet"],
    "coding-specialist": ["excluded-picker", "codex", "no-tools"],
    "fast-efficient": ["flash"],
  },
  models: [
    model("opus", "anthropic", "claude-opus", true, ["text", "image"]),
    model("sol", "openai", "gpt", true, ["text", "image"]),
    model("sonnet", "anthropic", "claude-sonnet", true, ["text", "image"]),
    model("codex", "openai", "gpt-codex", true, ["text", "image"]),
    model("no-tools", "microsoft", null, false, ["text"]),
    model("flash", "google", "gemini-flash", true, ["text", "image"]),
    model("mai-code-1-flash-picker", "microsoft", null, true, ["text"]),
  ],
};

function model(
  id: string,
  vendor: string,
  family: string | null,
  toolCall: boolean,
  input: string[],
) {
  return {
    id,
    name: id,
    vendor,
    family,
    description: `${id} description`,
    preview: false,
    modalities: { input, output: ["text"] },
    capabilities: {
      reasoning: true,
      tool_call: toolCall,
      structured_output: true,
      attachments: input.includes("image"),
    },
  };
}

describe("Copilot model catalog", () => {
  it("preserves canonical IDs and filters incompatible candidates", () => {
    const catalog = parseCopilotModelCatalog(RAW_CATALOG);
    const candidates = resolveRlmModelCandidates(catalog, {
      preferredGroups: [RlmModelGroup.CodingSpecialist],
      fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
      requiredCapabilities: { reasoning: true, toolCall: true },
    });

    expect(candidates.map(({ id }) => id)).toEqual(["codex", "sonnet"]);
    expect(candidates[0]).toMatchObject({
      id: "codex",
      group: RlmModelGroup.CodingSpecialist,
    });
  });

  it("uses family preference only within the preferred group", () => {
    const catalog = parseCopilotModelCatalog(RAW_CATALOG);
    const candidates = resolveRlmModelCandidates(catalog, {
      preferredGroups: [RlmModelGroup.FrontierCurrent],
      fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
      requiredCapabilities: { toolCall: true },
      preferredVendors: ["anthropic"],
    });

    expect(candidates.map(({ id }) => id)).toEqual(["opus", "sol", "sonnet"]);
  });

  it("accepts only offered model choices and falls back deterministically", () => {
    const catalog = parseCopilotModelCatalog(RAW_CATALOG);
    const policy = {
      preferredGroups: [RlmModelGroup.FastEfficient],
      requiredCapabilities: { toolCall: true },
    } as const;

    expect(resolveRlmModelDecision(catalog, policy, "flash")).toMatchObject({
      model: "flash",
      usedFallback: false,
    });
    expect(resolveRlmModelDecision(catalog, policy, "not-real")).toMatchObject({
      model: "flash",
      requestedModel: "not-real",
      usedFallback: true,
    });
  });

  it("fails closed when no current model satisfies the policy", () => {
    const catalog = parseCopilotModelCatalog(RAW_CATALOG);
    expect(() =>
      resolveRlmModelDecision(catalog, {
        preferredGroups: [RlmModelGroup.CodingSpecialist],
        requiredInputModalities: ["video"],
      }),
    ).toThrow(/No current Copilot model/u);
  });

  it("rejects malformed catalog payloads", () => {
    expect(() => parseCopilotModelCatalog({ groups: {}, models: [{ id: "" }] })).toThrow();
  });
});
