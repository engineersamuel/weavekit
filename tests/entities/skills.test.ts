import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSkillReference } from "../../src/entities/index.js";

describe("entity skill validation", () => {
  it("finds repo-local SKILL.md with matching frontmatter name", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-skills-"));
    const dir = join(root, ".copilot/skills/mckinsey-strategist");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: mckinsey-strategist\n---\n# Skill\n",
      "utf8",
    );

    expect(validateSkillReference("mckinsey-strategist", root)).toEqual({
      valid: true,
      errors: [],
      skillPath: join(dir, "SKILL.md"),
    });
  });

  it("rejects missing skill and frontmatter name mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-skills-"));
    expect(validateSkillReference("missing", root).errors[0]).toMatchObject({
      code: "entity.skill_missing",
      fieldPath: "capabilities.skills",
    });

    const dir = join(root, ".agents/skills/wrong");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: other\n---\n# Skill\n", "utf8");
    expect(validateSkillReference("wrong", root).errors[0]).toMatchObject({
      code: "entity.skill_name_mismatch",
      fieldPath: "capabilities.skills",
    });
  });
});
