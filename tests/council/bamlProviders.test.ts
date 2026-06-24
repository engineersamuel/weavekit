import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const proxyModels = [
  "claude-3-5-haiku",
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet",
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet",
  "claude-3-7-sonnet-20250219",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-6-20250515",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gpt-4.1",
  "gpt-4o",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.5",
  "grok-code-fast-1",
  "raptor-mini",
];

function providerName(model: string): string {
  const suffix = model
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

  return `CopilotProxy${suffix}`;
}

describe("BAML Copilot proxy providers", () => {
  it("defines a local proxy client for each advertised model and defaults to gpt-5-mini", async () => {
    const baml = await readFile("baml_src/clients.baml", "utf8");
    const council = await readFile("baml_src/council.baml", "utf8");

    expect(baml).toContain("base_url env.COPILOT_PROXY_BASE_URL");
    expect(baml).toContain("api_key env.COPILOT_PROXY_API_KEY");
    expect(baml).toContain('client<llm> DefaultClient');
    expect(baml).toContain('model "gpt-5-mini"');
    // Non-default proxy clients use a hardcoded local address
    expect(baml).toContain('base_url "http://127.0.0.1:8080/v1"');
    expect(council).not.toMatch(/^client<llm>/m);

    for (const model of proxyModels) {
      expect(baml).toContain(`client<llm> ${providerName(model)}`);
      expect(baml).toContain(`model "${model}"`);
    }
  });
});
