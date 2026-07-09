import { describe, expect, it } from "vitest";
import { RouterProvider } from "../../src/eval/providers/router.js";
import { createInitialWorkflowRouter } from "../../src/initialRouter.js";

describe("RouterProvider", () => {
  it("returns the router classification as a text summary", async () => {
    const provider = new RouterProvider({ router: createInitialWorkflowRouter() });
    const response = await provider.callApi(
      "Should we build our own orchestrator or adopt Flue? Recommend one.",
    );

    expect(response.error).toBeUndefined();
    expect(response.output).toContain("Route:");
    expect(response.output).toContain("decision-council");
  });
});
