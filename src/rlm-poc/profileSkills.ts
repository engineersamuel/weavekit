import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ExecFileOptions } from "node:child_process";
import { RlmSkillPolicyError, type RlmProfile, type RlmProfileSkillBundle } from "./contracts.js";

const execFileAsync = promisify(execFile);
type RlmCommandRunner = (
  file: string,
  args: string[],
  options?: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

type UpstreamSource = {
  repository: string;
  ref: string;
  updatePolicy: "latest";
};

export const MEDIA_YT_DLP_WRAPPER = `#!/usr/bin/env bash
set -euo pipefail

if ! command -v uvx >/dev/null 2>&1; then
  echo "yt-dlp requires uvx. Run 'mise install' from the weavekit repository." >&2
  exit 127
fi

exec uvx yt-dlp "$@"
`;

export const RLM_PROFILE_SKILL_SOURCES = {
  handoff: {
    repository: "https://github.com/mattpocock/skills.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  betterGithub: {
    repository: "https://github.com/AVGVSTVS96/better-github-skill.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  superpowers: {
    repository: "https://github.com/obra/superpowers.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  council: {
    repository: "https://github.com/0xNyk/council-of-high-intelligence.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  last30days: {
    repository: "https://github.com/mvanhorn/last30days-skill.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  hyperresearch: {
    repository: "https://github.com/jordan-gibbs/hyperresearch.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  anthropicSkills: {
    repository: "https://github.com/anthropics/skills.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  designerSkills: {
    repository: "https://github.com/Owl-Listener/designer-skills.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  infographic: {
    repository: "https://github.com/antvis/Infographic.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  img2threejs: {
    repository: "https://github.com/img2threejs/img2threejs.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  visualPlan: {
    repository: "https://github.com/BuilderIO/skills.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
  makerSkills: {
    repository: "https://github.com/coreyhaines31/makerskills.git",
    ref: "HEAD",
    updatePolicy: "latest",
  },
} as const satisfies Record<string, UpstreamSource>;

export const RLM_COMMON_PROFILE_SKILL_NAMES = ["rlm-handoff", "better-github-skill"] as const;

const ANTHROPIC_DESIGN_SKILLS = [
  "algorithmic-art",
  "brand-guidelines",
  "canvas-design",
  "frontend-design",
  "theme-factory",
  "web-artifacts-builder",
] as const;

const DESIGNER_SKILL_CATEGORIES = [
  "design-ops",
  "design-research",
  "design-systems",
  "designer-toolkit",
  "interaction-design",
  "prototyping-testing",
  "ui-design",
  "ux-strategy",
  "visual-critique",
] as const;

export type PreparedRlmProfileSkills = {
  skillDirectories: string[];
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
};

export type PrepareRlmProfileSkills = (
  profile: RlmProfile,
) => Promise<PreparedRlmProfileSkills | undefined>;
export type PrepareRlmRootSkills = () => Promise<PreparedRlmProfileSkills | undefined>;

export type RlmProfileSkillInstallerOptions = {
  cacheDir?: string;
  runCommand?: RlmCommandRunner;
};

const installs = new Map<string, Promise<PreparedRlmProfileSkills>>();

export function resolveRlmProfileSkillsCacheDir(override?: string): string {
  return override ?? join(process.cwd(), ".weavekit", "rlm-profile-skills");
}

export async function prepareRlmProfileSkills(
  profile: RlmProfile,
  options: RlmProfileSkillInstallerOptions = {},
): Promise<PreparedRlmProfileSkills> {
  const cacheDir = resolveRlmProfileSkillsCacheDir(options.cacheDir);
  const runCommand = options.runCommand ?? (execFileAsync as RlmCommandRunner);
  const skillBundle = profile.skillBundle;
  const [common, profileBundle] = await Promise.all([
    installOnce(`${cacheDir}:common`, () => installCommonProfileSkills(cacheDir, runCommand)),
    skillBundle
      ? installOnce(`${cacheDir}:${skillBundle}`, () =>
          installBundle(skillBundle, cacheDir, runCommand),
        )
      : undefined,
  ]);
  const prepared = profileBundle
    ? {
        ...profileBundle,
        skillDirectories: [...profileBundle.skillDirectories, ...common.skillDirectories],
      }
    : common;
  await assertPreparedRlmProfileSkillManifest(profile, prepared);
  return prepared;
}

export async function assertPreparedRlmProfileSkillManifest(
  profile: RlmProfile,
  prepared: PreparedRlmProfileSkills,
): Promise<void> {
  const installedNames = new Set<string>();
  await Promise.all(
    [...(profile.skillDirectories ?? []), ...prepared.skillDirectories].map((directory) =>
      collectInstalledSkillNames(directory, installedNames),
    ),
  );
  const expectedNames = [...RLM_COMMON_PROFILE_SKILL_NAMES, ...(profile.allowedSkillNames ?? [])];
  const missing = expectedNames.filter((name) => !installedNames.has(name));
  if (missing.length > 0) {
    throw new RlmSkillPolicyError(
      `RLM profile "${profile.name}" allows skills missing from its prepared bundle: ` +
        missing.join(", "),
    );
  }
}

async function collectInstalledSkillNames(
  directory: string,
  installedNames: Set<string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectInstalledSkillNames(path, installedNames);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        const contents = await readFile(path, "utf8");
        const name = contents.match(/^\s*name:\s*["']?([^\n"']+)["']?\s*$/mu)?.[1]?.trim();
        if (name) installedNames.add(name);
      }
    }),
  );
}

export async function prepareRlmRootSkills(
  options: RlmProfileSkillInstallerOptions = {},
): Promise<PreparedRlmProfileSkills> {
  const cacheDir = resolveRlmProfileSkillsCacheDir(options.cacheDir);
  const runCommand = options.runCommand ?? (execFileAsync as RlmCommandRunner);
  return installOnce(`${cacheDir}:handoff`, () => installHandoffSkill(cacheDir, runCommand));
}

async function installOnce(
  key: string,
  install: () => Promise<PreparedRlmProfileSkills>,
): Promise<PreparedRlmProfileSkills> {
  const existing = installs.get(key);
  if (existing) return existing;

  const installation = install();
  installs.set(key, installation);
  try {
    return await installation;
  } finally {
    if (installs.get(key) === installation) installs.delete(key);
  }
}

async function installHandoffSkill(
  cacheDir: string,
  runCommand: RlmCommandRunner,
): Promise<PreparedRlmProfileSkills> {
  const { checkout, revision } = await ensureCheckout(
    "handoff",
    RLM_PROFILE_SKILL_SOURCES.handoff,
    cacheDir,
    runCommand,
  );
  const skillDirectory = await ensureHandoffBundle(checkout, revision, cacheDir);
  return { skillDirectories: [skillDirectory] };
}

async function ensureHandoffBundle(
  checkout: string,
  revision: string,
  cacheDir: string,
): Promise<string> {
  const bundleRevision = `${revision}:model-invocable-v2`;
  const target = join(cacheDir, "bundles", "handoff", revision);
  const skills = join(target, "skills");
  if (await markerMatches(target, bundleRevision)) return skills;

  const upstreamSkill = join(checkout, "skills", "productivity", "handoff", "SKILL.md");
  if (!(await fileExists(upstreamSkill))) {
    throw new Error(`Handoff skill is missing from upstream checkout "${checkout}".`);
  }

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(join(dirname(target), ".install-"));
  try {
    const skill = join(temporaryRoot, "skills", "handoff");
    await mkdir(skill, { recursive: true });
    const source = await readFile(upstreamSkill, "utf8");
    await writeFile(join(skill, "SKILL.md"), adaptHandoffSkill(source), "utf8");
    await writeFile(join(temporaryRoot, ".weavekit-revision"), `${bundleRevision}\n`, "utf8");
    await installAtomically(temporaryRoot, target);
    if (!(await markerMatches(target, bundleRevision))) {
      throw new Error(`Handoff skill bundle failed verification at "${target}".`);
    }
    return skills;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function adaptHandoffSkill(source: string): string {
  return source
    .replace(/^name:\s*handoff\s*$/mu, "name: rlm-handoff")
    .replace(/^disable-model-invocation:\s*true\s*\n/mu, "");
}

async function installCommonProfileSkills(
  cacheDir: string,
  runCommand: RlmCommandRunner,
): Promise<PreparedRlmProfileSkills> {
  const [handoff, betterGithubSource] = await Promise.all([
    installHandoffSkill(cacheDir, runCommand),
    ensureCheckout(
      "better-github-skill",
      RLM_PROFILE_SKILL_SOURCES.betterGithub,
      cacheDir,
      runCommand,
    ),
  ]);
  const betterGithubSkills = await ensureBetterGithubBundle(betterGithubSource, cacheDir);
  return {
    skillDirectories: [...handoff.skillDirectories, betterGithubSkills],
  };
}

async function ensureBetterGithubBundle(
  source: ResolvedCheckout,
  cacheDir: string,
): Promise<string> {
  const bundleRevision = `${source.revision}:better-github-skill-md-only-v2`;
  const target = join(cacheDir, "bundles", "better-github", source.revision);
  const skills = join(target, "skills");
  if (await markerMatches(target, bundleRevision)) return skills;

  const upstreamSkill = join(source.checkout, "SKILL.md");
  if (!(await fileExists(upstreamSkill))) {
    throw new Error(`Better GitHub skill is missing from upstream checkout "${source.checkout}".`);
  }

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(join(dirname(target), ".install-"));
  try {
    const skill = join(temporaryRoot, "skills", "better-github-skill");
    await mkdir(skill, { recursive: true });
    await cp(upstreamSkill, join(skill, "SKILL.md"));
    await writeFile(join(temporaryRoot, ".weavekit-revision"), `${bundleRevision}\n`, "utf8");
    await installAtomically(temporaryRoot, target);
    if (!(await markerMatches(target, bundleRevision))) {
      throw new Error(`Better GitHub skill bundle failed verification at "${target}".`);
    }
    return skills;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function installBundle(
  bundle: RlmProfileSkillBundle,
  cacheDir: string,
  runCommand = execFileAsync as RlmCommandRunner,
): Promise<PreparedRlmProfileSkills> {
  switch (bundle) {
    case "superpowers": {
      const { checkout } = await ensureCheckout(
        "superpowers",
        RLM_PROFILE_SKILL_SOURCES.superpowers,
        cacheDir,
        runCommand,
      );
      return { skillDirectories: [join(checkout, "skills")] };
    }
    case "council": {
      const { checkout, revision } = await ensureCheckout(
        "council",
        RLM_PROFILE_SKILL_SOURCES.council,
        cacheDir,
        runCommand,
      );
      const skills = await ensureCouncilBundle(checkout, revision, cacheDir);
      const workingDirectory = join(cacheDir, "workspaces", "council");
      await mkdir(workingDirectory, { recursive: true });
      return { skillDirectories: [skills], workingDirectory };
    }
    case "research": {
      const [last30days, hyperresearch] = await Promise.all([
        ensureCheckout("last30days", RLM_PROFILE_SKILL_SOURCES.last30days, cacheDir, runCommand),
        ensureCheckout(
          "hyperresearch",
          RLM_PROFILE_SKILL_SOURCES.hyperresearch,
          cacheDir,
          runCommand,
        ),
      ]);
      const generated = await ensureHyperresearchBundle(
        hyperresearch.checkout,
        hyperresearch.revision,
        cacheDir,
        runCommand,
      );
      const workingDirectory = join(cacheDir, "workspaces", "research");
      await mkdir(workingDirectory, { recursive: true });
      return {
        skillDirectories: [
          join(last30days.checkout, "skills"),
          join(generated.project, ".claude", "skills"),
        ],
        environment: {
          PATH: [generated.runtimeBin, process.env.PATH].filter(Boolean).join(delimiter),
        },
        workingDirectory,
      };
    }
    case "design": {
      const [anthropic, designer, infographic, img2threejs, visualPlan] = await Promise.all([
        ensureCheckout(
          "anthropic-skills",
          RLM_PROFILE_SKILL_SOURCES.anthropicSkills,
          cacheDir,
          runCommand,
        ),
        ensureCheckout(
          "designer-skills",
          RLM_PROFILE_SKILL_SOURCES.designerSkills,
          cacheDir,
          runCommand,
        ),
        ensureCheckout("infographic", RLM_PROFILE_SKILL_SOURCES.infographic, cacheDir, runCommand),
        ensureCheckout("img2threejs", RLM_PROFILE_SKILL_SOURCES.img2threejs, cacheDir, runCommand),
        ensureCheckout("visual-plan", RLM_PROFILE_SKILL_SOURCES.visualPlan, cacheDir, runCommand),
      ]);
      const normalized = await ensureDesignBundle(
        {
          anthropic,
          img2threejs,
          visualPlan,
        },
        cacheDir,
      );
      return {
        skillDirectories: [
          normalized,
          ...DESIGNER_SKILL_CATEGORIES.map((category) =>
            join(designer.checkout, category, "skills"),
          ),
          join(infographic.checkout, "skills"),
        ],
      };
    }
    case "media": {
      const { checkout, revision } = await ensureCheckout(
        "maker-skills",
        RLM_PROFILE_SKILL_SOURCES.makerSkills,
        cacheDir,
        runCommand,
      );
      const generated = await ensureMediaBundle(checkout, revision, cacheDir);
      const workingDirectory = join(cacheDir, "workspaces", "media");
      await mkdir(workingDirectory, { recursive: true });
      return {
        skillDirectories: [generated.skillDirectory],
        environment: {
          PATH: [generated.runtimeBin, process.env.PATH].filter(Boolean).join(delimiter),
        },
        workingDirectory,
      };
    }
  }
}

async function ensureCheckout(
  name: string,
  source: UpstreamSource,
  cacheDir: string,
  runCommand: RlmCommandRunner,
): Promise<{ checkout: string; revision: string }> {
  const sourceRoot = join(cacheDir, "sources", name);
  const latestMarker = join(sourceRoot, ".latest-revision");
  let revision: string;
  try {
    revision = await resolveLatestRevision(source, runCommand);
  } catch (error) {
    const cachedRevision = await readOptionalText(latestMarker);
    const cachedTarget = cachedRevision ? join(sourceRoot, cachedRevision) : undefined;
    if (cachedRevision && cachedTarget && (await markerMatches(cachedTarget, cachedRevision))) {
      console.warn(
        `Could not check ${source.repository} for updates; using cached revision ${cachedRevision}.`,
      );
      return { checkout: cachedTarget, revision: cachedRevision };
    }
    throw error;
  }
  const target = join(sourceRoot, revision);
  if (await markerMatches(target, revision)) {
    await writeFile(latestMarker, `${revision}\n`, "utf8");
    return { checkout: target, revision };
  }

  await mkdir(sourceRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(dirname(target), ".install-"));
  const checkout = join(temporaryRoot, "checkout");
  try {
    await runCommand("git", ["init", "--quiet", checkout], { timeout: 60_000 });
    await runCommand("git", ["-C", checkout, "remote", "add", "origin", source.repository], {
      timeout: 60_000,
    });
    await runCommand(
      "git",
      ["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", revision],
      { timeout: 2 * 60_000 },
    );
    await runCommand("git", ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      timeout: 60_000,
    });
    await writeFile(join(checkout, ".weavekit-revision"), `${revision}\n`, "utf8");
    await installAtomically(checkout, target);
    if (!(await markerMatches(target, revision))) {
      throw new Error(`Resolved skill checkout failed verification at "${target}".`);
    }
    await writeFile(latestMarker, `${revision}\n`, "utf8");
    return { checkout: target, revision };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function resolveLatestRevision(
  source: UpstreamSource,
  runCommand: RlmCommandRunner,
): Promise<string> {
  const { stdout } = await runCommand("git", ["ls-remote", source.repository, source.ref], {
    timeout: 30_000,
  });
  const revision = stdout.trim().split(/\s+/u)[0];
  if (!revision || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(
      `Could not resolve ${source.repository} ${source.ref} to an immutable Git commit.`,
    );
  }
  return revision;
}

async function ensureCouncilBundle(
  checkout: string,
  revision: string,
  cacheDir: string,
): Promise<string> {
  const bundleRevision = `${revision}:council-v2`;
  const target = join(cacheDir, "bundles", "council", revision);
  if (await markerMatches(target, bundleRevision)) return join(target, "skills");

  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  const temporaryRoot = await mkdtemp(join(dirname(target), ".install-"));
  const skill = join(temporaryRoot, "skills", "council");
  try {
    await mkdir(skill, { recursive: true });
    const upstreamSkill = await readFile(join(checkout, "SKILL.codex.md"), "utf8");
    const assetResolution =
      "Resolve council files relative to the directory containing this loaded `SKILL.md`: " +
      "the member files are under `agents/`, scripts under `scripts/`, and configs under " +
      "`configs/`. These recursion-local assets are already installed; do not stop to request " +
      "another installation.";
    const adaptedSkill = upstreamSkill.replace(
      /Resolve council files in this order:[\s\S]*?If neither exists, stop and tell the user to run `\.\/install\.sh --codex`\./u,
      assetResolution,
    );
    if (adaptedSkill === upstreamSkill) {
      throw new Error("Council skill asset-resolution contract changed upstream.");
    }
    await writeFile(join(skill, "SKILL.md"), adaptedSkill, "utf8");
    await Promise.all([
      cp(join(checkout, "agents"), join(skill, "agents"), { recursive: true }),
      cp(join(checkout, "configs"), join(skill, "configs"), { recursive: true }),
      cp(join(checkout, "scripts"), join(skill, "scripts"), { recursive: true }),
    ]);
    await writeFile(join(temporaryRoot, ".weavekit-revision"), `${bundleRevision}\n`, "utf8");
    await installAtomically(temporaryRoot, target);
    if (!(await markerMatches(target, bundleRevision))) {
      throw new Error(`Council skill bundle failed verification at "${target}".`);
    }
    return join(target, "skills");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function ensureHyperresearchBundle(
  checkout: string,
  revision: string,
  cacheDir: string,
  runCommand: RlmCommandRunner,
): Promise<{ project: string; runtimeBin: string }> {
  const target = join(cacheDir, "bundles", "hyperresearch", revision);
  if (
    (await markerMatches(target, revision)) &&
    (await fileExists(join(target, "project", ".claude", "skills", "hyperresearch", "SKILL.md")))
  ) {
    return { project: join(target, "project"), runtimeBin: join(target, "runtime", "bin") };
  }

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const runtime = join(target, "runtime");
  const project = join(target, "project");
  const pythonSource = await resolveCompatiblePython(runCommand);
  const python = join(runtime, "bin", "python");
  const executable = join(runtime, "bin", "hyperresearch");
  try {
    await runCommand(pythonSource, ["-m", "venv", runtime], { timeout: 2 * 60_000 });
    await runCommand(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", checkout],
      { timeout: 15 * 60_000 },
    );
    await mkdir(project, { recursive: true });
    await runCommand(executable, ["install", project, "--json"], {
      env: process.env,
      timeout: 5 * 60_000,
    });
    const skill = join(project, ".claude", "skills", "hyperresearch", "SKILL.md");
    if (!(await fileExists(skill))) {
      throw new Error(`Hyperresearch install did not create expected skill "${skill}".`);
    }

    await writeFile(join(target, ".weavekit-revision"), `${revision}\n`, "utf8");
    return { project, runtimeBin: join(runtime, "bin") };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

type ResolvedCheckout = {
  checkout: string;
  revision: string;
};

async function ensureDesignBundle(
  sources: {
    anthropic: ResolvedCheckout;
    img2threejs: ResolvedCheckout;
    visualPlan: ResolvedCheckout;
  },
  cacheDir: string,
): Promise<string> {
  const bundleRevision = [
    "design-v1",
    sources.anthropic.revision,
    sources.img2threejs.revision,
    sources.visualPlan.revision,
  ].join(":");
  const key = createHash("sha256").update(bundleRevision).digest("hex");
  const target = join(cacheDir, "bundles", "design", key);
  if (await markerMatches(target, bundleRevision)) return join(target, "skills");

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(join(dirname(target), ".install-"));
  const skills = join(temporaryRoot, "skills");
  try {
    await mkdir(skills, { recursive: true });
    await Promise.all([
      ...ANTHROPIC_DESIGN_SKILLS.map((name) =>
        cp(join(sources.anthropic.checkout, "skills", name), join(skills, name), {
          recursive: true,
        }),
      ),
      cp(join(sources.visualPlan.checkout, "skills", "visual-plan"), join(skills, "visual-plan"), {
        recursive: true,
      }),
      cp(sources.img2threejs.checkout, join(skills, "img2threejs"), {
        recursive: true,
        filter: (source) => {
          const path = relative(sources.img2threejs.checkout, source);
          const firstSegment = path.split(sep)[0];
          return firstSegment !== ".git" && firstSegment !== "skills";
        },
      }),
    ]);
    await cp(
      join(sources.visualPlan.checkout, "LICENSE"),
      join(skills, "visual-plan", "LICENSE.upstream"),
    );
    await writeFile(join(temporaryRoot, ".weavekit-revision"), `${bundleRevision}\n`, "utf8");
    await installAtomically(temporaryRoot, target);
    if (!(await markerMatches(target, bundleRevision))) {
      throw new Error(`Design skill bundle failed verification at "${target}".`);
    }
    return join(target, "skills");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function ensureMediaBundle(
  checkout: string,
  revision: string,
  cacheDir: string,
): Promise<{ skillDirectory: string; runtimeBin: string }> {
  const bundleRevision = `${revision}:media-copilot-proxy-v3`;
  const target = join(cacheDir, "bundles", "media", revision);
  if (await markerMatches(target, bundleRevision)) {
    return {
      skillDirectory: join(target, "skills"),
      runtimeBin: join(target, "bin"),
    };
  }

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(join(dirname(target), ".install-"));
  const upstreamSkill = join(checkout, "skills", "watch-video");
  const skill = join(temporaryRoot, "skills", "watch-video");
  const runtimeBin = join(temporaryRoot, "bin");
  try {
    await cp(upstreamSkill, skill, { recursive: true });
    await cp(join(checkout, "LICENSE"), join(skill, "LICENSE.upstream"));
    const upstreamInstructions = await readFile(join(upstreamSkill, "SKILL.md"), "utf8");
    await writeFile(join(skill, "SKILL.md"), adaptWatchVideoSkill(upstreamInstructions), "utf8");
    await mkdir(runtimeBin, { recursive: true });
    const ytDlpWrapper = join(runtimeBin, "yt-dlp");
    await writeFile(ytDlpWrapper, MEDIA_YT_DLP_WRAPPER, "utf8");
    await chmod(ytDlpWrapper, 0o755);
    await writeFile(join(temporaryRoot, ".weavekit-revision"), `${bundleRevision}\n`, "utf8");
    await installAtomically(temporaryRoot, target);
    if (!(await markerMatches(target, bundleRevision))) {
      throw new Error(`Media skill bundle failed verification at "${target}".`);
    }
    return {
      skillDirectory: join(target, "skills"),
      runtimeBin: join(target, "bin"),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function adaptWatchVideoSkill(upstreamSkill: string): string {
  let adapted = replaceRequired(
    upstreamSkill,
    "multimodal (Gemini native video ingestion if $GEMINI_API_KEY set, else dense Claude vision)",
    "multimodal (dense Claude vision through the local copilot-proxy-rs service)",
    "frontmatter multimodal description",
  );
  adapted = replaceRequired(
    adapted,
    "| `/watch-video <url> multimodal` | multimodal | Native video to Gemini (if `$GEMINI_API_KEY`), else dense Claude vision frame-by-frame |",
    "| `/watch-video <url> multimodal` | multimodal | Dense frame-by-frame Claude vision through local copilot-proxy-rs |",
    "multimodal mode table",
  );
  adapted = replaceRequired(
    adapted,
    "Pair each frame with the transcript chunk for the same timestamp window. Then batch-send to Claude vision for synthesis.",
    "Pair each frame with the transcript chunk for the same timestamp window. Batch-send the frames through the local copilot-proxy-rs Anthropic Messages image contract described in Step 8.",
    "visual mode proxy routing",
  );

  const proxyMultimodalInstructions = `## Step 8 - If \`multimodal\` mode

The weavekit media profile uses the local Copilot-subscription-backed proxy instead of an external
video API key. The proxy does not expose native video upload, so multimodal mode performs dense local frame
extraction and sends timestamped image batches to Claude through Anthropic Messages.

### Proxy preflight

1. Require \`http://127.0.0.1:8080/health\` to return successfully.
2. Read \`/v1/models\` and require \`claude-sonnet-5\`; do not assume a model that is not advertised.
3. Use \`http://127.0.0.1:8080/v1/messages\`. If \`COPILOT_PROXY_API_KEY\` is non-empty, add it as a
   bearer authorization header at execution time without printing it.

If the proxy or model is unavailable, report the failure and offer visual or transcript mode. Never
fall back to an external model credential.

### Dense frame extraction

- Extract one frame every 3 seconds by default. Preserve the source-specific cadence rules when they
  require denser coverage, and add scene-change frames for slide presentations.
- Resize frames to at most 1280 pixels on the longest edge and encode them as JPEG to bound payload
  size. Keep the original timestamp in each filename.
- Pair every frame with the transcript window covering that timestamp.

### Copilot-backed vision requests

Send Anthropic Messages requests with model \`claude-sonnet-5\`. Each user content array contains
interleaved \`image\` blocks using base64 JPEG sources and \`text\` blocks containing timestamps,
transcript windows, and the Step 7 analysis prompt.

- Use no more than 10 frames per request.
- Keep each complete JSON request below 12 MiB so it remains under the proxy's default 16 MiB decoded
  body limit. Reduce the batch size when encoded frames are larger.
- Do not log request bodies, encoded frames, credentials, or raw proxy responses.
- Retry a failed batch at most once with fewer frames, then fail closed or offer visual/transcript
  fallback.
- Merge batch observations by timestamp into \`moments.md\`, then produce \`summary.md\` using the
  existing multimodal output contract.

Long videos can create many Copilot vision calls and substantial local processing. Confirmation for
videos over 10 minutes remains mandatory even though no separate model API key is used.

`;
  const stepEightPattern = /## Step 8[^\n]*\n[\s\S]*?(?=## Step 9)/u;
  const withProxyStep = adapted.replace(stepEightPattern, proxyMultimodalInstructions);
  if (withProxyStep === adapted) {
    throw new Error("Watch-video multimodal section changed upstream.");
  }
  adapted = withProxyStep;
  adapted = replaceRequired(
    adapted,
    "| Multimodal requested but no `$GEMINI_API_KEY` and >30min video | Warn cost, offer to fall back to visual mode |",
    "| Multimodal requested but the local proxy/model is unavailable | Report the dependency gap and offer visual or transcript mode |",
    "multimodal error handling",
  );
  adapted = replaceRequired(
    adapted,
    "- **Multimodal cost warning is non-optional.** Gemini multimodal on a 60-min video is meaningfully expensive. Warn before running; offer transcript-only as fallback if the user isn't sure.",
    "- **Multimodal workload warning is non-optional.** Dense frame analysis of a 60-minute video creates many proxy calls and substantial local processing. Confirm before running and offer transcript-only fallback.",
    "multimodal workload warning",
  );
  adapted = replaceRequired(
    adapted,
    "| `yt-dlp` binary missing | `brew install yt-dlp` |",
    "| `yt-dlp` unavailable | Run `mise install` from the weavekit repository to provision the `uvx`-backed wrapper |",
    "yt-dlp dependency guidance",
  );
  if (/GEMINI_API_KEY|generativelanguage\.googleapis\.com|Gemini native/u.test(adapted)) {
    throw new Error("Adapted watch-video skill still references the Gemini API path.");
  }
  return adapted;
}

function replaceRequired(
  source: string,
  search: string,
  replacement: string,
  contract: string,
): string {
  const adapted = source.replace(search, replacement);
  if (adapted === source) {
    throw new Error(`Watch-video ${contract} changed upstream.`);
  }
  return adapted;
}

export async function resolveCompatiblePython(
  runCommand: RlmCommandRunner = execFileAsync as RlmCommandRunner,
): Promise<string> {
  for (const candidate of ["python3.13", "python3.12", "python3.11", "python3"]) {
    try {
      const { stdout } = await runCommand(candidate, [
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
      ]);
      const [major, minor] = stdout.trim().split(".").map(Number);
      if (major === 3 && minor !== undefined && minor >= 11 && minor <= 13) {
        return candidate;
      }
    } catch {
      // Try the next explicit interpreter name; failure is reported after all candidates.
    }
  }
  throw new Error(
    "The research profile requires Python 3.11, 3.12, or 3.13 to install Hyperresearch.",
  );
}

async function installAtomically(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !(await pathExists(target))) {
      throw error;
    }
  }
}

async function markerMatches(directory: string, revision: string): Promise<boolean> {
  try {
    return (await readFile(join(directory, ".weavekit-revision"), "utf8")).trim() === revision;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
