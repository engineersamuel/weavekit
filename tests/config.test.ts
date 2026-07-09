import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeepResearchProvider,
  expandHomePath,
  loadLocalEnvFiles,
  loadTypedWeavekitConfig,
  loadWeavekitConfig,
  resolveProjectCatalogEntry,
} from "../src/config.js";

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
    await writeFile(
      join(dir, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=dot-env-token",
        "TELEGRAM_OWNER_CHAT_ID=123",
        "EXISTING=value-from-dotenv",
      ].join("\n"),
    );
    await writeFile(
      join(dir, ".env.fish"),
      [
        "set -gx COPILOT_PROXY_BASE_URL http://127.0.0.1:8080/v1",
        "set -gx TELEGRAM_OWNER_CHAT_ID 456",
        'set -gx FISH_QUOTED "hello world"',
      ].join("\n"),
    );
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
    await writeFile(
      configPath,
      'COPILOT_PROXY_BASE_URL = "http://127.0.0.1:8080/v1"\nBAML_MODEL = "gpt-5-mini"\n',
    );

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
    await writeFile(
      configPath,
      `
COPILOT_PROXY_BASE_URL = "http://127.0.0.1:8080/v1"

[copilot]
verbose_events = true
model = "gpt-5-mini"
runtime_url = "http://127.0.0.1:9999"
cli_path = "~/bin/copilot"
sdk_doctor_model = "gpt-5-mini"

[flue]
model = "anthropic/claude-sonnet-4-6"

[tooling]
skills_directory = "~/.weavekit/skills"
agent_native_skills_installer = "/opt/tools/agent-skills"
agent_native_skills_package = "@agent-native/skills@0.2.249"
mise_bin = "/opt/homebrew/bin/mise"

[source_to_project]
max_opportunities = 1
min_applicability = 0.7
min_confidence = 0.65
min_impact = 0.5
min_acceptance_average = 0.85
max_risk = 0.8
mode = "advisory"
offline = true
copilot_model = "gpt-5.5"
timeout_ms = 120000
max_tool_calls = 50
source_reading_max_tool_calls = 20
project_research_max_tool_calls = 30

[deep_research]
providers = ["exa", "perplexity"]
max_iterations = 4
questions_per_iteration = 6
max_results_per_question = 7
provider_retry_attempts = 2
visualize = true

[verification_optimizer]
mode = "advisory"
external_research = true
min_confidence = 0.9
min_impact = 0.7
max_risk = 0.25
max_implementation_cost = 0.4
min_evidence_references = 3
require_non_speculative = false
require_proof_commands = false

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
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.copilot.verboseEvents).toBe(true);
    expect(config.copilot.model).toBe("gpt-5-mini");
    expect(config.copilot.runtimeUrl).toBe("http://127.0.0.1:9999");
    expect(config.copilot.cliPath).toBe(join(homedir(), "bin/copilot"));
    expect(config.copilot.sdkDoctorModel).toBe("gpt-5-mini");
    expect(config.flue.model).toBe("anthropic/claude-sonnet-4-6");
    expect(config.tooling.skillsDirectory).toBe(join(homedir(), ".weavekit/skills"));
    expect(config.tooling.agentNativeSkillsInstaller).toBe("/opt/tools/agent-skills");
    expect(config.tooling.agentNativeSkillsPackage).toBe("@agent-native/skills@0.2.249");
    expect(config.tooling.miseBin).toBe("/opt/homebrew/bin/mise");
    expect(config.sourceToProject.maxOpportunities).toBe(1);
    expect(config.sourceToProject.offline).toBe(true);
    expect(config.sourceToProject.copilotModel).toBe("gpt-5.5");
    expect(config.sourceToProject.timeoutMs).toBe(120000);
    expect(config.sourceToProject.maxToolCalls).toBe(50);
    expect(config.sourceToProject.sourceReadingMaxToolCalls).toBe(20);
    expect(config.sourceToProject.projectResearchMaxToolCalls).toBe(30);
    expect(config.deepResearch).toEqual({
      providers: ["exa", "perplexity"],
      maxIterations: 4,
      questionsPerIteration: 6,
      maxResultsPerQuestion: 7,
      providerRetryAttempts: 2,
      visualize: true,
    });
    expect(config.verificationOptimizer).toEqual({
      mode: "advisory",
      externalResearch: true,
      thresholds: {
        minConfidence: 0.9,
        minImpact: 0.7,
        maxRisk: 0.25,
        maxImplementationCost: 0.4,
        minEvidenceReferences: 3,
        requireNonSpeculative: false,
        requireProofCommands: false,
      },
    });
    expect(config.sourceToProject.prLauncher).toEqual({
      provider: "herdr",
      agentCommand: "codex",
      agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      split: "right",
      agentOptions: [
        {
          id: "codex",
          label: "Codex",
          agentCommand: "codex",
          agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        },
        { id: "copilot", label: "Copilot", agentCommand: "copilot", agentArgs: ["--allow-all"] },
      ],
    });
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

  it("loads source-to-project manual PR launcher configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
[source_to_project.pr_launcher]
provider = "herdr"
agent_command = "claude"
agent_args = ["--dangerously-skip-permissions"]
split = "down"
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.sourceToProject.prLauncher).toEqual({
      provider: "herdr",
      agentCommand: "claude",
      agentArgs: ["--dangerously-skip-permissions"],
      split: "down",
      agentOptions: [
        {
          id: "codex",
          label: "Codex",
          agentCommand: "codex",
          agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        },
        { id: "copilot", label: "Copilot", agentCommand: "copilot", agentArgs: ["--allow-all"] },
      ],
    });
  });

  it("does not materialize undefined project threshold override fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
[source_to_project]
min_acceptance_average = 0.9

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/tmp/weavekit"
mainline = "origin main"
remote = "origin"
context_docs = []
validation_commands = []
autonomous_pr_allowed = false
notification = "cli"
knowledge_export = "off"
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {});
    const spreadThresholds = {
      ...config.sourceToProject.thresholds,
      ...config.projects.weavekit?.thresholds,
    };

    expect(Object.keys(config.projects.weavekit?.thresholds ?? {})).toEqual([]);
    expect(spreadThresholds.minAcceptanceAverage).toBe(0.9);
  });

  it("loads custom source-to-project PR launcher agent options for the Create PR dropdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
[[source_to_project.pr_launcher.agent_options]]
id = "claude"
label = "Claude"
agent_command = "claude"
agent_args = ["--dangerously-skip-permissions"]

[[source_to_project.pr_launcher.agent_options]]
id = "copilot"
label = "Copilot"
agent_command = "copilot"
agent_args = ["--allow-all"]
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.sourceToProject.prLauncher.agentOptions).toEqual([
      {
        id: "claude",
        label: "Claude",
        agentCommand: "claude",
        agentArgs: ["--dangerously-skip-permissions"],
      },
      { id: "copilot", label: "Copilot", agentCommand: "copilot", agentArgs: ["--allow-all"] },
    ]);
  });

  it("expands a leading tilde in project working tree paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
[projects.weavekit]
working_tree = "~/projects/personal/weavekit"
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.projects.weavekit?.workingTree).toBe(
      join(homedir(), "projects/personal/weavekit"),
    );
  });

  it("loads and expands the hve-core plugin directory from typed config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
[plugins.hve-core]
directory = "~/.copilot/installed-plugins/_direct/hve-core"
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {});

    expect(config.plugins["hve-core"]?.directory).toBe(
      join(homedir(), ".copilot/installed-plugins/_direct/hve-core"),
    );
  });

  it("prefers the hve-core plugin directory from config over the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `
[plugins.hve-core]
directory = "/config/hve-core"
`,
      "utf8",
    );

    const config = loadTypedWeavekitConfig(configPath, {
      WEAVEKIT_HVE_CORE_PLUGIN_DIR: "/env/hve-core",
    });

    expect(config.plugins["hve-core"]?.directory).toBe("/config/hve-core");
  });

  it("uses WEAVEKIT_HVE_CORE_PLUGIN_DIR before the default plugin directory", () => {
    const config = loadTypedWeavekitConfig("/tmp/weavekit-missing-config.toml", {
      WEAVEKIT_HVE_CORE_PLUGIN_DIR: "~/plugins/hve-core",
    });

    expect(config.plugins["hve-core"]?.directory).toBe(join(homedir(), "plugins/hve-core"));
  });

  it("loads first-party uppercase env vars only as typed config fallbacks", () => {
    const config = loadTypedWeavekitConfig("/tmp/weavekit-missing-config.toml", {
      WEAVEKIT_SOURCE_TO_PROJECT_OFFLINE: "true",
      WEAVEKIT_SOURCE_TO_PROJECT_MODEL: "copilot-override",
      WEAVEKIT_SOURCE_TO_PROJECT_TIMEOUT_MS: "600000",
      WEAVEKIT_SOURCE_TO_PROJECT_MAX_TOOL_CALLS: "72",
      WEAVEKIT_SOURCE_READING_MAX_TOOL_CALLS: "12",
      WEAVEKIT_PROJECT_RESEARCH_MAX_TOOL_CALLS: "24",
      WEAVEKIT_DEEP_RESEARCH_PROVIDERS: "grok,copilot-last30days,grok,tavily",
      WEAVEKIT_DEEP_RESEARCH_MAX_ITERATIONS: "5",
      WEAVEKIT_DEEP_RESEARCH_QUESTIONS_PER_ITERATION: "8",
      WEAVEKIT_DEEP_RESEARCH_MAX_RESULTS_PER_QUESTION: "9",
      WEAVEKIT_DEEP_RESEARCH_PROVIDER_RETRY_ATTEMPTS: "2",
      WEAVEKIT_DEEP_RESEARCH_VISUALIZE: "true",
      WEAVEKIT_COPILOT_VERBOSE_EVENTS: "true",
      COPILOT_MODEL: "gpt-5-mini",
      COPILOT_RUNTIME_URL: "http://127.0.0.1:8181",
      COPILOT_CLI_PATH: "~/bin/copilot",
      WEAVEKIT_ENTITY_SDK_DOCTOR_MODEL: "gpt-5-mini",
      WEAVEKIT_FLUE_MODEL: "anthropic/claude-haiku-4-5",
      WEAVEKIT_AGENT_NATIVE_SKILLS_INSTALLER: "/tools/agent-skills",
      WEAVEKIT_AGENT_NATIVE_SKILLS_PACKAGE: "@agent-native/skills@0.2.249",
      WEAVEKIT_MISE_BIN: "/tools/mise",
      WEAVEKIT_SKILLS_DIR: "~/cache/skills",
    });

    expect(config.sourceToProject.offline).toBe(true);
    expect(config.sourceToProject.copilotModel).toBe("copilot-override");
    expect(config.sourceToProject.timeoutMs).toBe(600000);
    expect(config.sourceToProject.maxToolCalls).toBe(72);
    expect(config.sourceToProject.sourceReadingMaxToolCalls).toBe(12);
    expect(config.sourceToProject.projectResearchMaxToolCalls).toBe(24);
    expect(config.deepResearch).toEqual({
      providers: ["grok", "copilot-last30days", "tavily"],
      maxIterations: 5,
      questionsPerIteration: 8,
      maxResultsPerQuestion: 9,
      providerRetryAttempts: 2,
      visualize: true,
    });
    expect(config.copilot.verboseEvents).toBe(true);
    expect(config.copilot.model).toBe("gpt-5-mini");
    expect(config.copilot.runtimeUrl).toBe("http://127.0.0.1:8181");
    expect(config.copilot.cliPath).toBe(join(homedir(), "bin/copilot"));
    expect(config.copilot.sdkDoctorModel).toBe("gpt-5-mini");
    expect(config.flue.model).toBe("anthropic/claude-haiku-4-5");
    expect(config.tooling.agentNativeSkillsInstaller).toBe("/tools/agent-skills");
    expect(config.tooling.agentNativeSkillsPackage).toBe("@agent-native/skills@0.2.249");
    expect(config.tooling.miseBin).toBe("/tools/mise");
    expect(config.tooling.skillsDirectory).toBe(join(homedir(), "cache/skills"));
  });

  it("expands only current-user home path prefixes", () => {
    expect(expandHomePath("~", "/home/tester")).toBe("/home/tester");
    expect(expandHomePath("~/projects/weavekit", "/home/tester")).toBe(
      join("/home/tester", "projects/weavekit"),
    );
    expect(expandHomePath("~other/projects/weavekit", "/home/tester")).toBe(
      "~other/projects/weavekit",
    );
    expect(expandHomePath("relative/weavekit", "/home/tester")).toBe("relative/weavekit");
  });

  it("resolves a project catalog entry or throws a useful error", async () => {
    const config = {
      env: {},
      copilot: {
        verboseEvents: false,
      },
      flue: {
        model: "anthropic/claude-haiku-4-5",
      },
      tooling: {},
      sourceToProject: {
        maxOpportunities: 1,
        thresholds: {
          minApplicability: 0.7,
          minConfidence: 0.65,
          minImpact: 0.5,
          minAcceptanceAverage: 0.85,
          maxRisk: 0.8,
        },
        mode: "advisory" as const,
        offline: false,
        prLauncher: {
          provider: "herdr" as const,
          agentCommand: "codex",
          agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
          split: "right" as const,
          agentOptions: [],
        },
        autoImplementOnReport: false,
      },
      deepResearch: {
        providers: [
          DeepResearchProvider.GROK,
          DeepResearchProvider.EXA,
          DeepResearchProvider.COPILOT_LAST30DAYS,
        ],
        maxIterations: 3,
        questionsPerIteration: 5,
        maxResultsPerQuestion: 5,
        providerRetryAttempts: 1,
        visualize: false,
      },
      verificationOptimizer: {
        mode: "autonomous-pr" as const,
        externalResearch: false,
        thresholds: {
          minConfidence: 0.85,
          minImpact: 0.6,
          maxRisk: 0.35,
          maxImplementationCost: 0.45,
          minEvidenceReferences: 2,
          requireNonSpeculative: true,
          requireProofCommands: true,
        },
      },
      plugins: {
        "hve-core": {
          directory: "/plugins/hve-core",
        },
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
    expect(() => resolveProjectCatalogEntry(config, "missing")).toThrow(
      "Unknown project id: missing",
    );
  });

  it("defaults Copilot verbose event logging to false when config is missing", () => {
    const config = loadTypedWeavekitConfig("/tmp/weavekit-missing-config.toml", {});

    expect(config.copilot.verboseEvents).toBe(false);
    expect(config.sourceToProject.offline).toBe(false);
    expect(config.deepResearch).toEqual({
      providers: ["grok", "exa", "copilot-last30days"],
      maxIterations: 3,
      questionsPerIteration: 5,
      maxResultsPerQuestion: 5,
      providerRetryAttempts: 1,
      visualize: false,
    });
    expect(config.verificationOptimizer).toEqual({
      mode: "autonomous-pr",
      externalResearch: false,
      thresholds: {
        minConfidence: 0.85,
        minImpact: 0.6,
        maxRisk: 0.35,
        maxImplementationCost: 0.45,
        minEvidenceReferences: 2,
        requireNonSpeculative: true,
        requireProofCommands: true,
      },
    });
    expect(config.flue.model).toBe("anthropic/claude-haiku-4-5");
    expect(config.plugins["hve-core"]?.directory).toBe(
      join(homedir(), ".copilot/installed-plugins/_direct/hve-core"),
    );
  });
});
