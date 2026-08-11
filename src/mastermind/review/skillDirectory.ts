import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_SKILL_NAME = "weavekit-ticket-review";

type ReviewSkillPathExists = (path: string) => boolean;

export function resolveReviewSkillDiscoveryDirectory(
  options: {
    skillsDirectory?: string;
    moduleUrl?: string;
    pathExists?: ReviewSkillPathExists;
  } = {},
): string {
  const pathExists = options.pathExists ?? existsSync;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const checked: string[] = [];
  const explicitSkillsDirectory = options.skillsDirectory?.trim();
  if (explicitSkillsDirectory) {
    checked.push(explicitSkillsDirectory);
    if (pathExists(skillManifestPath(explicitSkillsDirectory))) {
      return explicitSkillsDirectory;
    }
    throw new Error(
      [
        `Mastermind review skill ${REVIEW_SKILL_NAME} was not found in the configured skill directory.`,
        `Expected ${skillManifestPath(explicitSkillsDirectory)}.`,
        `Checked: ${checked.join(", ")}.`,
        "Run `nub run build` to package the skill into dist/.github/skills or restore the repository-local .github/skills directory.",
      ].join(" "),
    );
  }

  for (const candidate of reviewSkillDiscoveryCandidates(moduleUrl)) {
    checked.push(candidate);
    if (pathExists(skillManifestPath(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    [
      `Mastermind review skill ${REVIEW_SKILL_NAME} was not found in any bundled skill directory.`,
      `Checked: ${checked.join(", ")}.`,
      "Run `nub run build` to copy .github/skills/weavekit-ticket-review into dist/.github/skills, or run from the repository source tree that still contains .github/skills.",
    ].join(" "),
  );
}

function reviewSkillDiscoveryCandidates(moduleUrl: string): string[] {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const moduleLocalSkillsDirectory = resolve(moduleDirectory, "../../../.github/skills");
  const repositorySourceSkillsDirectory = resolve(moduleDirectory, "../../../../.github/skills");
  const candidates = [moduleLocalSkillsDirectory];
  if (moduleDirectory.split(sep).includes("dist")) {
    candidates.push(repositorySourceSkillsDirectory);
  }
  return [...new Set(candidates)];
}

function skillManifestPath(skillsDirectory: string): string {
  return join(skillsDirectory, REVIEW_SKILL_NAME, "SKILL.md");
}
