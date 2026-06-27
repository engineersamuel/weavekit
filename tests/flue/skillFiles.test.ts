import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src/skills/using-superpowers");

describe("using-superpowers Flue skill files", () => {
  it("includes the skill frontmatter and key references", () => {
    const skill = readFileSync(join(root, "SKILL.md"), "utf8");

    expect(skill).toContain("name: using-superpowers");
    expect(skill).toContain("description:");
    expect(existsSync(join(root, "references/copilot-tools.md"))).toBe(true);
    expect(existsSync(join(root, "references/pi-tools.md"))).toBe(true);
  });
});
