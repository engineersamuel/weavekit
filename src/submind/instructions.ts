import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SUBMIND_OPERATING_SKILL_NAME = "mastermind-submind";

export function submindOperatingSkillPath(skillsDirectory: string): string {
  return join(skillsDirectory, SUBMIND_OPERATING_SKILL_NAME, "SKILL.md");
}

export async function loadSubmindOperatingSkill(moduleUrl = import.meta.url): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDirectory, "../../.github/skills")];
  if (moduleDirectory.split(sep).includes("dist")) {
    candidates.push(resolve(moduleDirectory, "../../../.github/skills"));
  }
  for (const skillsDirectory of candidates) {
    try {
      return await readFile(submindOperatingSkillPath(skillsDirectory), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `Mastermind submind skill was not found. Checked: ${candidates.map(submindOperatingSkillPath).join(", ")}.`,
  );
}
