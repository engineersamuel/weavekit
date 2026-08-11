import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_SKILL_NAME } from "../src/mastermind/review/skillDirectory.js";
import { SUBMIND_OPERATING_SKILL_NAME } from "../src/submind/instructions.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationSkillsDirectory = join(repoRoot, "dist", ".github", "skills");
const skillNames = [REVIEW_SKILL_NAME, SUBMIND_OPERATING_SKILL_NAME];

async function main(): Promise<void> {
  for (const skillName of skillNames) {
    const sourceSkillDirectory = join(repoRoot, ".github", "skills", skillName);
    try {
      await access(join(sourceSkillDirectory, "SKILL.md"));
    } catch {
      throw new Error(
        `Mastermind skill source is missing: ${join(sourceSkillDirectory, "SKILL.md")}.`,
      );
    }
  }
  await rm(destinationSkillsDirectory, { recursive: true, force: true });
  await mkdir(destinationSkillsDirectory, { recursive: true });
  for (const skillName of skillNames) {
    await cp(
      join(repoRoot, ".github", "skills", skillName),
      join(destinationSkillsDirectory, skillName),
      { recursive: true },
    );
  }
}

await main();
