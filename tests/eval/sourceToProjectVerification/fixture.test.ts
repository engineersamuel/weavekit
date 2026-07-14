import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";

describe("controlled todo project verification fixture", () => {
  it("pins known source practices and intentional project gaps", async () => {
    const definition = loadProjectVerificationCase();
    const server = await readFile(`${definition.projectDir}/src/server.ts`, "utf8");
    const browser = await readFile(`${definition.projectDir}/public/app.js`, "utf8");
    const source = await readFile(definition.sourcePath, "utf8");

    expect(definition.expectedPractices.map((practice) => practice.id)).toEqual([
      "validate-http-boundaries",
      "separate-domain-from-transport",
      "use-a-stable-error-contract",
      "render-user-content-safely",
      "test-the-vertical-slice",
    ]);
    expect(server).toContain("req.body.title");
    expect(server).toContain("todos.push");
    expect(browser).toContain("innerHTML");
    expect(source).toContain("Validate at every HTTP boundary");
    expect(source).toMatch(/Never interpolate\s+persisted user text into `innerHTML`/);
  });
});
