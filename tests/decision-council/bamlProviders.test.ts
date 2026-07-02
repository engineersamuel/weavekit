import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BAML_CANDIDATE_CLIENT_MODELS } from "../../src/decision-council/modelRouter.js";

const activeBamlClientModels = {
  ...BAML_CANDIDATE_CLIENT_MODELS,
  CopilotProxyGpt55: "gpt-5.5",
} as const;

function clientBlock(baml: string, clientName: string): string {
  const start = baml.indexOf(`client<llm> ${clientName} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = baml.indexOf("\nclient<llm>", start + 1);
  return baml.slice(start, next === -1 ? undefined : next);
}

describe("BAML Copilot proxy providers", () => {
  it("defines local proxy clients for every active routed model and uses env.BAML_MODEL for DefaultClient", async () => {
    const baml = await readFile("baml_src/clients.baml", "utf8");
    const council = await readFile("baml_src/council.baml", "utf8");

    expect(baml).toContain("base_url env.COPILOT_PROXY_BASE_URL");
    expect(baml).toContain("api_key env.COPILOT_PROXY_API_KEY");
    expect(baml).toContain('client<llm> DefaultClient');
    expect(baml).toContain('model env.BAML_MODEL');
    // Non-default proxy clients use a hardcoded local address
    expect(baml).toContain('base_url "http://127.0.0.1:8080/v1"');
    expect(council).not.toMatch(/^client<llm>/m);

    for (const [clientName, model] of Object.entries(activeBamlClientModels)) {
      const block = clientBlock(baml, clientName);
      expect(block).toContain(`model "${model}"`);
      if (clientName === "CopilotProxyGpt55") {
        expect(block).toContain('provider "openai-responses"');
      } else {
        expect(block).toContain('provider "openai-generic"');
      }
    }
  });

  it("keeps Claude replanning prompts from being system-message only", async () => {
    const planner = await readFile("baml_src/workflow_planner.baml", "utf8");
    const functionStart = planner.indexOf("function GenerateReplanPatch");
    expect(functionStart).toBeGreaterThanOrEqual(0);
    const functionBlock = planner.slice(functionStart);

    expect(functionBlock).toContain("client CopilotProxyClaudeOpus48");
    expect(functionBlock).toContain('{{ _.role("system") }}');
    expect(functionBlock).toContain('{{ _.role("user") }}');
  });
});
