import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PersonaSkill } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface EnsureSkillOptions {
  skill: PersonaSkill;
  cacheDir?: string;
}

/**
 * Resolves the skills cache directory. Precedence:
 *   1. explicit `override` arg
 *   2. `WEAVEKIT_SKILLS_DIR` env variable
 *   3. `<repoRoot>/.weavekit/skills` (repo root found by upward search for package.json)
 */
export function resolveSkillsCacheDir(override?: string): string {
  if (override) return override;
  const envDir = process.env.WEAVEKIT_SKILLS_DIR;
  if (envDir) return envDir;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, "package.json"))) {
      return join(dir, ".weavekit", "skills");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not locate repo root (package.json) searching upward from ` +
      `${fileURLToPath(import.meta.url)}. Set WEAVEKIT_SKILLS_DIR to override.`,
  );
}

/**
 * Lazily installs a persona skill into the gitignored cache via claude-superskills.
 * Idempotent: if the skill's SKILL.md already exists, returns immediately.
 * Returns the discovery directory (`<cacheDir>/.github/skills`) to pass as `skillDirectories`.
 */
export async function ensureSkillInstalled(opts: EnsureSkillOptions): Promise<string> {
  const cacheDir = resolveSkillsCacheDir(opts.cacheDir);
  const discoveryDir = join(cacheDir, ".github", "skills");
  const skillMd = join(discoveryDir, opts.skill.name, "SKILL.md");

  // Idempotency: skip install if already present
  if (existsSync(skillMd)) {
    return discoveryDir;
  }

  if (!opts.skill.bundle) {
    throw new Error(
      `PersonaSkill "${opts.skill.name}" is missing required field "bundle". ` +
        `Cannot install via ${opts.skill.installer}. Add a "bundle" value to the skill definition.`,
    );
  }

  // Resolve the real claude-superskills package root (nub may symlink into a content-addressed store)
  const require = createRequire(import.meta.url);
  const pkgRoot = realpathSync(dirname(require.resolve("claude-superskills/package.json")));
  const cli = join(pkgRoot, "bin", "cli.js");

  // Copy our committed bundles.json to both probe paths the upstream CLI looks in
  const bundlesSrc = join(dirname(fileURLToPath(import.meta.url)), "skills", "bundles.json");
  cpSync(bundlesSrc, join(pkgRoot, "bundles.json"));
  cpSync(bundlesSrc, join(pkgRoot, "..", "bundles.json"));

  // Ensure the discovery directory exists before the installer runs
  mkdirSync(discoveryDir, { recursive: true });

  // Run the installer (async so the worker stays non-blocking)
  await execFileAsync(
    process.execPath,
    [cli, "install", "--bundle", opts.skill.bundle, "--scope", "local", "-y"],
    { cwd: cacheDir },
  );

  // Post-install verification
  if (!existsSync(skillMd)) {
    throw new Error(
      `Skill install verification failed: expected SKILL.md at "${skillMd}" after running ` +
        `bundle "${opts.skill.bundle}" via "${cli}". ` +
        `Check claude-superskills output and ensure the bundle is valid.`,
    );
  }

  return discoveryDir;
}
