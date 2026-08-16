import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RlmProfileAuthority, RlmProfilePurpose } from "../../src/rlm-poc/contracts.js";
import {
  RLM_COMMON_PROFILE_SKILL_NAMES,
  MEDIA_YT_DLP_WRAPPER,
  RLM_PROFILE_SKILL_SOURCES,
  adaptHandoffSkill,
  adaptWatchVideoSkill,
  assertPreparedRlmProfileSkillManifest,
  prepareRlmProfileSkills,
  resolveCompatiblePython,
  resolveRlmProfileSkillsCacheDir,
} from "../../src/rlm-poc/profileSkills.js";
import { defaultRlmProfileRegistry } from "../../src/rlm-poc/profiles.js";

describe("RLM profile skill bundles", () => {
  it("tracks every upstream repository's latest default revision", () => {
    expect(Object.keys(RLM_PROFILE_SKILL_SOURCES)).toEqual([
      "handoff",
      "betterGithub",
      "superpowers",
      "council",
      "last30days",
      "hyperresearch",
      "anthropicSkills",
      "designerSkills",
      "infographic",
      "img2threejs",
      "visualPlan",
      "makerSkills",
    ]);
    for (const source of Object.values(RLM_PROFILE_SKILL_SOURCES)) {
      expect(source.repository).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/u);
      expect(source.ref).toBe("HEAD");
      expect(source.updatePolicy).toBe("latest");
    }
  });

  it("installs common skills for a profile without a specialized skill bundle", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "rlm-handoff-test-"));
    const revision = "a".repeat(40);
    const runCommand = async (_file: string, args: string[]) => {
      if (args[0] === "ls-remote") {
        return { stdout: `${revision}\tHEAD\n`, stderr: "" };
      }
      if (args[0] === "init") {
        const checkout = args.at(-1);
        if (!checkout) throw new Error("Missing checkout path.");
        if (checkout.includes("better-github-skill")) {
          await mkdir(checkout, { recursive: true });
          await writeFile(
            join(checkout, "SKILL.md"),
            "---\nname: better-github-skill\n---\n",
            "utf8",
          );
          await mkdir(join(checkout, "scripts"), { recursive: true });
          await writeFile(join(checkout, "scripts", "excluded.ts"), "export {};\n", "utf8");
        } else {
          const skill = join(checkout, "skills", "productivity", "handoff");
          await mkdir(skill, { recursive: true });
          await writeFile(
            join(skill, "SKILL.md"),
            "---\nname: handoff\ndisable-model-invocation: true\n---\n",
            "utf8",
          );
        }
      }
      return { stdout: "", stderr: "" };
    };

    try {
      const prepared = await prepareRlmProfileSkills(
        {
          name: "general",
          description: "General execution.",
          purpose: RlmProfilePurpose.Execution,
          authority: RlmProfileAuthority.Implementation,
          repositoryWritePermission: true,
          model: "test-model",
          systemMessagePrompt: "Execute.",
        },
        { cacheDir, runCommand },
      );
      expect(prepared.skillDirectories).toEqual([
        join(cacheDir, "bundles", "handoff", revision, "skills"),
        join(cacheDir, "bundles", "better-github", revision, "skills"),
      ]);
      await expect(
        readFile(
          join(cacheDir, "bundles", "handoff", revision, "skills", "handoff", "SKILL.md"),
          "utf8",
        ),
      ).resolves.not.toContain("disable-model-invocation");
      await expect(
        stat(
          join(
            cacheDir,
            "bundles",
            "better-github",
            revision,
            "skills",
            "better-github-skill",
            "SKILL.md",
          ),
        ),
      ).resolves.toBeDefined();
      await expect(
        stat(
          join(
            cacheDir,
            "bundles",
            "better-github",
            revision,
            "skills",
            "better-github-skill",
            "scripts",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("uses the repository-local ignored cache by default", () => {
    expect(resolveRlmProfileSkillsCacheDir()).toMatch(/[/\\]\.weavekit[/\\]rlm-profile-skills$/u);
  });

  it("adapts handoff for model invocation in recursive sessions", () => {
    const upstream =
      "---\nname: handoff\ndisable-model-invocation: true\n---\n\nWrite a handoff.\n";

    expect(adaptHandoffSkill(upstream)).toBe("---\nname: rlm-handoff\n---\n\nWrite a handoff.\n");
  });

  it("adapts watch-video multimodal analysis to the local Copilot proxy", () => {
    const upstream = `---
description: multimodal (Gemini native video ingestion if $GEMINI_API_KEY set, else dense Claude vision)
---
| \`/watch-video <url> multimodal\` | multimodal | Native video to Gemini (if \`$GEMINI_API_KEY\`), else dense Claude vision frame-by-frame |
Pair each frame with the transcript chunk for the same timestamp window. Then batch-send to Claude vision for synthesis.
## Step 8 - If multimodal mode
Gemini native via https://generativelanguage.googleapis.com and $GEMINI_API_KEY.
## Step 9 - Optional capture
| Multimodal requested but no \`$GEMINI_API_KEY\` and >30min video | Warn cost, offer to fall back to visual mode |
- **Multimodal cost warning is non-optional.** Gemini multimodal on a 60-min video is meaningfully expensive. Warn before running; offer transcript-only as fallback if the user isn't sure.
| \`yt-dlp\` binary missing | \`brew install yt-dlp\` |
`;

    const adapted = adaptWatchVideoSkill(upstream);

    expect(adapted).toContain("http://127.0.0.1:8080/v1/messages");
    expect(adapted).toContain("claude-sonnet-5");
    expect(adapted).toContain("no more than 10 frames per request");
    expect(adapted).toContain("below 12 MiB");
    expect(adapted).toContain(
      "Run `mise install` from the weavekit repository to provision the `uvx`-backed wrapper",
    );
    expect(adapted).not.toMatch(/GEMINI_API_KEY|generativelanguage|Gemini native/u);
    expect(adapted).not.toContain("brew install yt-dlp");
  });

  it("routes the generated yt-dlp wrapper through uvx", async () => {
    const root = await mkdtemp(join(tmpdir(), "rlm-media-runtime-test-"));
    const bin = join(root, "bin");
    const wrapper = join(root, "yt-dlp");
    try {
      await mkdir(bin);
      const uvx = join(bin, "uvx");
      await writeFile(uvx, '#!/bin/sh\nprintf "%s\\n" "$@"\n', "utf8");
      await chmod(uvx, 0o755);
      await writeFile(wrapper, MEDIA_YT_DLP_WRAPPER, "utf8");
      await chmod(wrapper, 0o755);

      const output = execFileSync(wrapper, ["--version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [bin, "/usr/bin", "/bin"].join(":"),
        },
      });

      expect(output).toBe("yt-dlp\n--version\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects only a Hyperresearch-compatible Python interpreter", async () => {
    const attempted: string[] = [];
    const selected = await resolveCompatiblePython(async (file) => {
      attempted.push(file);
      if (file === "python3.13") throw new Error("missing");
      if (file === "python3.12") return { stdout: "3.14\n", stderr: "" };
      return { stdout: "3.11\n", stderr: "" };
    });

    expect(selected).toBe("python3.11");
    expect(attempted).toEqual(["python3.13", "python3.12", "python3.11"]);
  });

  it("proves every specialized manifest name resolves to a prepared SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "rlm-manifest-test-"));
    const profiles = [
      defaultRlmProfileRegistry.resolve("research"),
      defaultRlmProfileRegistry.resolve("design"),
      defaultRlmProfileRegistry.resolve("media"),
    ];
    try {
      for (const profile of profiles) {
        const directory = join(root, profile.name);
        await Promise.all(
          [...RLM_COMMON_PROFILE_SKILL_NAMES, ...(profile.allowedSkillNames ?? [])].map(
            async (name) => {
              const skill = join(directory, name);
              await mkdir(skill, { recursive: true });
              await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
            },
          ),
        );
        await expect(
          assertPreparedRlmProfileSkillManifest(profile, {
            skillDirectories: [directory],
          }),
        ).resolves.toBeUndefined();
      }

      await rm(join(root, "design", "critique-color", "SKILL.md"));
      await expect(
        assertPreparedRlmProfileSkillManifest(profiles[1]!, {
          skillDirectories: [join(root, "design")],
        }),
      ).rejects.toThrow("critique-color");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
