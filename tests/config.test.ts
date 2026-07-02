import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandHomePath, loadLocalEnvFiles, loadTypedWeavekitConfig, loadWeavekitConfig, resolveProjectCatalogEntry } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("weavekit config loader", () => {
  it("loads local .env and .env.fish values without overriding existing env vars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-env-"));
    tempDirs.push(dir);
    await writeFile(join(dir, ".env"), [
      "TELEGRAM_BOT_TOKEN=dot-env-token",
      "TELEGRAM_OWNER_CHAT_ID=123",
      "EXISTING=value-from-dotenv",
    ].join("\n"));
    await writeFile(join(dir, ".env.fish"), [
      "set -gx COPILOT_PROXY_BASE_URL http://127.0.0.1:8080/v1",
      "set -gx TELEGRAM_OWNER_CHAT_ID 456",
      "set -gx FISH_QUOTED \"hello world\"",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { EXISTING: "already-set" };

    const loaded = loadLocalEnvFiles(dir, env);

    expect(loaded).toMatchObject({
      TELEGRAM_BOT_TOKEN: "dot-env-token",
      TELEGRAM_OWNER_CHAT_ID: "123",
      COPILOT_PROXY_BASE_URL: "http://127.0.0.1:8080/v1",
      FISH_QUOTED: "hello world",
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBe("dot-env-token");
    expect(env.TELEGRAM_OWNER_CHAT_ID).toBe("123");
    expect(env.COPILOT_PROXY_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.EXISTING).toBe("already-set");
  });

  it("loads environment values from a config file without overriding existing env vars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, 'COPILOT_PROXY_BASE_URL = "http://127.0.0.1:8080/v1"\nBAML_MODEL = "gpt-5-mini"\n');

    const original = process.env.COPILOT_PROXY_BASE_URL;
    process.env.COPILOT_PROXY_BASE_URL = "https://existing.example/v1";

    try {
      const loaded = loadWeavekitConfig(configPath, process.env);
      expect(loaded).toEqual({
        COPILOT_PROXY_BASE_URL: "http://127.0.0.1:8080/v1",
        BAML_MODEL: "gpt-5-mini",
      });
      expect(process.env.COPILOT_PROXY_BASE_URL).toBe("https://existing.example/v1");
      expect(process.env.BAML_MODEL).toBe("gpt-5-mini");
    } finally {
      if (original === undefined) {
        delete process.env.COPILOT_PROXY_BASE_URL;
      } else {
        process.env.COPILOT_PROXY_BASE_URL = original;
      }
      delete process.env.BAML_MODEL;
    }
  });

  it("loads source-to-project defaults and named project catalog entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, `
COPILOT_PROXY_BASE_URL = "http://127.0.0.1:8080/v1"

[copilot]
verbose_events = true

[source_to_project]
max_opportunities = 1
min_applicability = 0.7
min_confidence = 0.65
min_impact = 0.5
min_acceptance_average = 0.85
max_risk = 0.8
mode = "advisory"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/tmp/weavekit"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md", "docs/adr"]
validation_commands = ["nub run typecheck", "nub run test"]
autonomous_pr_allowed = true
max_opportunities = 2
notification = "telegram"
knowledge_export = "off"
`, "utf8");

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.copilot.verboseEvents).toBe(true);
    expect(config.sourceToProject.maxOpportunities).toBe(1);
    expect(config.sourceToProject.thresholds.minApplicability).toBe(0.7);
    expect(config.sourceToProject.thresholds.minAcceptanceAverage).toBe(0.85);
    expect(config.projects.weavekit).toMatchObject({
      id: "weavekit",
      displayName: "Weavekit",
      workingTree: "/tmp/weavekit",
      mainline: "origin main",
      validationCommands: ["nub run typecheck", "nub run test"],
      autonomousPrAllowed: true,
      maxOpportunities: 2,
      notification: "telegram",
    });
  });

  it("expands a leading tilde in project working tree paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, `
[projects.weavekit]
working_tree = "~/projects/personal/weavekit"
`, "utf8");

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.projects.weavekit?.workingTree).toBe(join(homedir(), "projects/personal/weavekit"));
  });

  it("expands only current-user home path prefixes", () => {
    expect(expandHomePath("~", "/home/tester")).toBe("/home/tester");
    expect(expandHomePath("~/projects/weavekit", "/home/tester")).toBe(join("/home/tester", "projects/weavekit"));
    expect(expandHomePath("~other/projects/weavekit", "/home/tester")).toBe("~other/projects/weavekit");
    expect(expandHomePath("relative/weavekit", "/home/tester")).toBe("relative/weavekit");
  });

  it("resolves a project catalog entry or throws a useful error", async () => {
    const config = {
      env: {},
      copilot: {
        verboseEvents: false,
      },
      sourceToProject: {
        maxOpportunities: 1,
        thresholds: { minApplicability: 0.7, minConfidence: 0.65, minImpact: 0.5, minAcceptanceAverage: 0.85, maxRisk: 0.8 },
        mode: "advisory" as const,
      },
      projects: {
        weavekit: {
          id: "weavekit",
          displayName: "Weavekit",
          workingTree: "/tmp/weavekit",
          mainline: "origin main",
          remote: "origin",
          contextDocs: ["CONTEXT.md"],
          validationCommands: ["nub run typecheck"],
          autonomousPrAllowed: true,
          notification: "cli" as const,
          knowledgeExport: "off" as const,
        },
      },
    };

    expect(resolveProjectCatalogEntry(config, "weavekit").workingTree).toBe("/tmp/weavekit");
    expect(() => resolveProjectCatalogEntry(config, "missing")).toThrow("Unknown project id: missing");
  });

  it("defaults Copilot verbose event logging to false when config is missing", () => {
    const config = loadTypedWeavekitConfig("/tmp/weavekit-missing-config.toml", {});

    expect(config.copilot.verboseEvents).toBe(false);
  });
});
