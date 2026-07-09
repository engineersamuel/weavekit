import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { EntityValidationError } from "./schema.js";

type SkillValidationResult = {
  valid: boolean;
  errors: EntityValidationError[];
  skillPath?: string;
};

function candidateSkillPaths(skillName: string, repoRoot: string): string[] {
  return [
    join(repoRoot, ".agents", "skills", skillName, "SKILL.md"),
    join(repoRoot, ".copilot", "skills", skillName, "SKILL.md"),
    join(homedir(), ".agents", "skills", skillName, "SKILL.md"),
    join(homedir(), ".copilot", "skills", skillName, "SKILL.md"),
  ];
}

function parseFrontmatterName(markdown: string): string | undefined {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = YAML.parse(match[1]) as { name?: unknown } | null;
  return typeof parsed?.name === "string" ? parsed.name : undefined;
}

export function validateSkillReference(
  skillName: string,
  repoRoot = process.cwd(),
): SkillValidationResult {
  const searchedPaths = candidateSkillPaths(skillName, repoRoot);
  const skillPath = searchedPaths.find((path) => existsSync(path));

  if (!skillPath) {
    return {
      valid: false,
      errors: [
        {
          code: "entity.skill_missing",
          fieldPath: "capabilities.skills",
          message: `Skill ${skillName} was not found.`,
          repairHint: `Create a SKILL.md for ${skillName} or remove it from capabilities.skills. Searched: ${searchedPaths.join(", ")}`,
          value: skillName,
        },
      ],
    };
  }

  const frontmatterName = parseFrontmatterName(readFileSync(skillPath, "utf8"));
  if (frontmatterName !== skillName) {
    return {
      valid: false,
      skillPath,
      errors: [
        {
          code: "entity.skill_name_mismatch",
          filePath: skillPath,
          fieldPath: "capabilities.skills",
          message: `Skill ${skillName} has SKILL.md frontmatter name ${frontmatterName ?? "<missing>"}.`,
          repairHint: `Set SKILL.md frontmatter name to "${skillName}" or update capabilities.skills.`,
          value: frontmatterName,
        },
      ],
    };
  }

  return { valid: true, errors: [], skillPath };
}
