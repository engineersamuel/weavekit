import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCopilotCliPathFromSdkModuleUrl, runEntitySdkDoctor } from "../../scripts/entity-sdk-doctor.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function createRepoWithSkillBackedPersona(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "weavekit-sdk-doctor-"));
  tempDirs.push(root);
  await write(root, "entities/personas/mckinsey-strategist.yaml", `
id: mckinsey-strategist
kind: persona
name: McKinsey Strategist
description: Strategy advisor.
persona:
  role: advisor
  archetype: analyst
  tags: ["strategy"]
selection:
  useWhen: ["Use for strategy."]
  avoidWhen: ["Avoid for implementation detail."]
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./mckinsey-strategist.md
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
capabilities:
  skills: ["mckinsey-strategist"]
`);
  await write(root, "entities/personas/mckinsey-strategist.md", "Use the strategy skill.");
  await write(root, ".copilot/skills/mckinsey-strategist/SKILL.md", "---\nname: mckinsey-strategist\n---\n# Skill\n");
  await write(root, ".copilot/skills/other-skill/SKILL.md", "---\nname: other-skill\n---\n# Skill\n");
  return root;
}

async function createHveCorePluginConfig(root: string): Promise<{ configPath: string; pluginDir: string }> {
  const pluginDir = join(root, "plugins", "hve-core");
  const configPath = join(root, "config.toml");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(configPath, `
[plugins.hve-core]
directory = "${pluginDir}"
`, "utf8");
  return { configPath, pluginDir };
}

async function addNoSkillCopilotSdkPersona(root: string): Promise<void> {
  await write(root, "entities/personas/pragmatic.yaml", `
id: pragmatic
kind: persona
name: Pragmatic Builder
description: Finds the smallest next step.
persona:
  role: advisor
  archetype: analyst
  tags: ["implementation"]
selection:
  useWhen: ["Use for delivery."]
  avoidWhen: ["Avoid for adversarial critique."]
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./pragmatic.md
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
`);
  await write(root, "entities/personas/pragmatic.md", "Use pragmatic judgment.");
}

describe("entity SDK doctor", () => {
  it("resolves the Copilot CLI binary from the SDK package layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-sdk-doctor-cli-"));
    tempDirs.push(root);
    const sdkIndex = join(root, "node_modules", ".nub", "@github+copilot-sdk@1.0.4-a", "node_modules", "@github", "copilot-sdk", "dist", "index.js");
    const copilotCli = join(root, "node_modules", ".nub", "@github+copilot-darwin-arm64@1.0.65-b", "node_modules", "@github", "copilot-darwin-arm64", "index.js");
    await write(root, "node_modules/.nub/@github+copilot-sdk@1.0.4-a/node_modules/@github/copilot-sdk/dist/index.js", "");
    await write(root, "node_modules/.nub/@github+copilot-darwin-arm64@1.0.65-b/node_modules/@github/copilot-darwin-arm64/index.js", "#!/usr/bin/env node\n");

    expect(resolveCopilotCliPathFromSdkModuleUrl(pathToFileURL(sdkIndex).href)).toBe(copilotCli);
  });

  it("loads configured entity skills in a Copilot SDK session", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const session = {
      rpc: {
        skills: {
          ensureLoaded: vi.fn(async () => undefined),
          list: vi.fn(async () => ({
            skills: [{
              name: "mckinsey-strategist",
              enabled: true,
              path: join(repoRoot, ".copilot", "skills", "mckinsey-strategist", "SKILL.md"),
            }],
          })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(async () => session),
      stop: vi.fn(async () => undefined),
    };

    const output = await runEntitySdkDoctor({
      repoRoot,
      entityId: "mckinsey-strategist",
      clientFactory: () => client,
    });

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      skillDirectories: [join(repoRoot, ".copilot", "skills")],
      disabledSkills: ["other-skill"],
    }));
    expect(session.rpc.skills.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(session.rpc.skills.list).toHaveBeenCalledTimes(1);
    expect(output).toContain("mckinsey-strategist: skill mckinsey-strategist loaded");
  });

  it("uses the typed SDK doctor model from config", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const configPath = join(repoRoot, "config.toml");
    await writeFile(configPath, `
[copilot]
sdk_doctor_model = "gpt-5-mini"
`, "utf8");
    const session = {
      rpc: {
        skills: {
          ensureLoaded: vi.fn(async () => undefined),
          list: vi.fn(async () => ({
            skills: [{
              name: "mckinsey-strategist",
              enabled: true,
              path: join(repoRoot, ".copilot", "skills", "mckinsey-strategist", "SKILL.md"),
            }],
          })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(async () => session),
      stop: vi.fn(async () => undefined),
    };

    await runEntitySdkDoctor({
      repoRoot,
      entityId: "mckinsey-strategist",
      configPath,
      clientFactory: () => client,
    });

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5-mini",
      skillDirectories: [join(repoRoot, ".copilot", "skills")],
    }));
  });

  it("reports copilot-sdk entities without configured skills", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const { configPath, pluginDir } = await createHveCorePluginConfig(repoRoot);
    await addNoSkillCopilotSdkPersona(repoRoot);
    const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const skillSession = {
      rpc: {
        skills: {
          ensureLoaded: vi.fn(async () => undefined),
          list: vi.fn(async () => ({
            skills: [{ name: "mckinsey-strategist", enabled: true }],
          })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const pluginSession = {
      rpc: {
        plugins: {
          list: vi.fn(async () => ({
            plugins: [{ id: "hve-core", enabled: true }],
          })),
        },
        commands: {
          list: vi.fn(async () => ({
            commands: [{ name: "hve-core:task-research" }],
          })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(async (config: unknown) =>
        "pluginDirectories" in (config as Record<string, unknown>) ? pluginSession : skillSession
      ),
      stop: vi.fn(async () => undefined),
    };

    const output = await runEntitySdkDoctor({
      repoRoot,
      configPath,
      shell: {
        async run(command, args, options) {
          shellCalls.push({ command, args, cwd: options.cwd });
          return "visual-plan dry run ok";
        },
      },
      clientFactory: () => client,
    });

    expect(output.trimEnd().split("\n")).toEqual([
      "✅ pragmatic: no capabilities.skills configured",
      "✅ source-to-project/visual-plan-preflight: visual-plan installer dry run succeeded",
      "✅ mckinsey-strategist: skill mckinsey-strategist loaded",
      "✅ source-to-project/project-research: plugin command hve-core:task-research discovered",
    ]);
    expect(output).toContain("mckinsey-strategist: skill mckinsey-strategist loaded");
    expect(output).toContain("pragmatic: no capabilities.skills configured");
    expect(output).toContain("source-to-project/visual-plan-preflight: visual-plan installer dry run succeeded");
    expect(output).toContain("source-to-project/project-research: plugin command hve-core:task-research discovered");
    expect(shellCalls).toEqual([{
      command: "nub",
      args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan", "--dry-run", "--no-connect"],
      cwd: repoRoot,
    }]);
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      pluginDirectories: [pluginDir],
    }));
    expect(client.createSession).toHaveBeenCalledTimes(2);
  });

  it("fails the visual-plan installer dry run when hosted auth is pending", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(),
      stop: vi.fn(async () => undefined),
    };

    await expect(runEntitySdkDoctor({
      repoRoot,
      shell: {
        async run() {
          return [
            "Skipped URL-only hosted MCP config for codex, cowork; run agent-native connect https://plan.agent-native.com --client codex,cowork --scope user to write bearer auth.",
            "Authentication skipped (non-interactive). To finish auth, run: npx @agent-native/core@latest connect https://plan.agent-native.com --client claude-code,codex,cowork,cursor,opencode,github-copilot --scope user",
            "Authentication pending",
          ].join("\n");
        },
      },
      clientFactory: () => client,
    })).rejects.toThrow("visual-plan hosted capability is not usable");

    expect(client.start).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("times out when the visual-plan installer dry run hangs", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(),
      stop: vi.fn(async () => undefined),
    };

    await expect(runEntitySdkDoctor({
      repoRoot,
      timeoutMs: 1,
      shell: {
        async run() {
          return await new Promise<string>(() => undefined);
        },
      },
      clientFactory: () => client,
    })).rejects.toThrow("Timed out after 1ms during source-to-project visual-plan installer dry run");

    expect(client.start).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("fails before starting the SDK when the hve-core plugin directory is missing", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const configPath = join(repoRoot, "config.toml");
    const missingPluginDir = join(repoRoot, "plugins", "missing-hve-core");
    await writeFile(configPath, `
[plugins.hve-core]
directory = "${missingPluginDir}"
`, "utf8");
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(),
      stop: vi.fn(async () => undefined),
    };

    await expect(runEntitySdkDoctor({
      repoRoot,
      configPath,
      clientFactory: () => client,
    })).rejects.toThrow(`Configured plugin directory for hve-core does not exist: ${missingPluginDir}`);

    expect(client.start).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("fails when the SDK session does not list the declared plugin command", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const { configPath } = await createHveCorePluginConfig(repoRoot);
    const skillSession = {
      rpc: {
        skills: {
          ensureLoaded: vi.fn(async () => undefined),
          list: vi.fn(async () => ({ skills: [{ name: "mckinsey-strategist", enabled: true }] })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const pluginSession = {
      rpc: {
        plugins: {
          list: vi.fn(async () => ({
            plugins: [{ id: "hve-core", enabled: true }],
          })),
        },
        commands: {
          list: vi.fn(async () => ({
            commands: [{ name: "hve-core:other-command" }],
          })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(async (config: unknown) =>
        "pluginDirectories" in (config as Record<string, unknown>) ? pluginSession : skillSession
      ),
      stop: vi.fn(async () => undefined),
    };

    await expect(runEntitySdkDoctor({
      repoRoot,
      configPath,
      shell: {
        async run() {
          return "visual-plan dry run ok";
        },
      },
      clientFactory: () => client,
    })).rejects.toThrow("Copilot SDK session did not list command hve-core:task-research");
  });

  it("times out a stalled SDK plugin command session instead of hanging", async () => {
    const repoRoot = await createRepoWithSkillBackedPersona();
    const { configPath } = await createHveCorePluginConfig(repoRoot);
    const skillSession = {
      rpc: {
        skills: {
          ensureLoaded: vi.fn(async () => undefined),
          list: vi.fn(async () => ({ skills: [{ name: "mckinsey-strategist", enabled: true }] })),
        },
      },
      disconnect: vi.fn(async () => undefined),
    };
    const client = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn(async (config: unknown) => {
        if ("pluginDirectories" in (config as Record<string, unknown>)) {
          return new Promise<never>(() => undefined);
        }
        return skillSession;
      }),
      stop: vi.fn(async () => undefined),
    };

    await expect(runEntitySdkDoctor({
      repoRoot,
      configPath,
      timeoutMs: 5,
      shell: {
        async run() {
          return "visual-plan dry run ok";
        },
      },
      clientFactory: () => client,
    })).rejects.toThrow("Timed out after 5ms during source-to-project plugin command SDK session");
  });
});
