import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("router.baml", () => {
  it("defines RouteModelCall pinned to the mini router client", async () => {
    const router = await readFile("baml_src/router.baml", "utf8");

    expect(router).toContain("class RoutingDecision");
    expect(router).toContain("function RouteModelCall");
    expect(router).toContain("client CopilotProxyGpt5Mini");
  });

  it("exposes a generated b.RouteModelCall binding", async () => {
    const generated = await readFile("src/generated/baml_client/async_client.ts", "utf8");

    expect(generated).toContain("RouteModelCall");
  });
});
