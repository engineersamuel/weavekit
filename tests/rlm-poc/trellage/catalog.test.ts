import { describe, expect, it } from "vitest";
import {
  buildTrellageCommand,
  buildHeadlessTrellageCommand,
  createTrellageCatalog,
  discoverTrellageProfiles,
  headlessCapabilitiesFor,
  selectRlmTrellageProfiles,
  supportsHeadlessTrellage,
  type TrellageCommandRunner,
} from "../../../src/rlm-poc/trellage/catalog.js";
import {
  TrellageHarness,
  TrellageMode,
  TrellageUnknownProfileError,
} from "../../../src/rlm-poc/trellage/contracts.js";
import { headlessAdapterFor } from "../../../src/rlm-poc/trellage/adapters/index.js";
import { claudeHeadlessAdapter } from "../../../src/rlm-poc/trellage/adapters/claude.js";

/** Recorded from the installed launchers, so parsing is tested against the real payload shapes. */
const COMPATIBLE_CONTAINER_HEADLESS = {
  prompt: true,
  outputFormats: ["text", "jsonl"],
  eventContract: "claude-stream-json-v1",
  trellageEventContract: "trellage-headless-v1",
  sessionId: "native",
  resume: true,
  resumeWithPrompt: true,
  questionToolControl: "hard-deny",
  changedFiles: "git-diff",
  usage: true,
  cost: true,
  modelOverride: true,
  effortOverride: false,
  testedHarnessVersion: "2.1.233",
};

const CONTAINER_FULL_LIST = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      name: "claude-council",
      description: "Multi-agent council.",
      sandbox: true,
      headless: COMPATIBLE_CONTAINER_HEADLESS,
    },
    {
      name: "claude-legacy",
      description: "Misleading Claude profile without compatible headless support.",
      sandbox: true,
      headless: {
        ...COMPATIBLE_CONTAINER_HEADLESS,
        prompt: false,
        outputFormats: ["text"],
        eventContract: "unsupported-events-v1",
        sessionId: "none",
        resume: false,
        resumeWithPrompt: false,
        questionToolControl: "none",
        changedFiles: "none",
        usage: false,
        cost: false,
      },
    },
  ],
});

const CONTAINER_BASIC_LIST = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    { name: "claude-council", description: "Multi-agent council.", sandbox: true },
    { name: "claude-legacy", description: "Basic inventory only.", sandbox: true },
  ],
});

const TRX_LIST = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      launcher: "cpx",
      harness: "copilot",
      name: "hve",
      description: "HVE profile.",
      sandbox: false,
    },
    {
      launcher: "grx",
      harness: "grok",
      name: "superpowers",
      description: "Superpowers profile.",
      sandbox: true,
    },
    {
      launcher: "cldx",
      harness: "claude",
      name: "default",
      description: "Default Claude Code profile.",
      sandbox: false,
    },
    {
      launcher: "omp",
      harness: "oh-my-pi",
      name: "copilot",
      description: "OMP with Copilot models.",
      sandbox: false,
    },
    {
      launcher: "omp",
      harness: "oh-my-pi",
      name: "local",
      description: "OMP with local models.",
      sandbox: false,
    },
  ],
});

const CPX_LIST = JSON.stringify({
  schemaVersion: 1,
  launcher: "cpx",
  harness: "copilot",
  sandbox: true,
  profiles: [
    {
      name: "hve",
      description: "HVE profile.",
      standaloneMcps: [],
    },
  ],
});

function createRunner(responses: Record<string, string>): TrellageCommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(" ");
    const stdout = responses[key];
    if (stdout === undefined) throw new Error(`command not found: ${key}`);
    return { stdout };
  };
}

describe("discoverTrellageProfiles", () => {
  it("normalizes the container and native catalog shapes into one profile list", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json --full": CONTAINER_FULL_LIST,
        "trx list --json": TRX_LIST,
      }),
    );

    expect(profiles).toContainEqual({
      harness: TrellageHarness.Container,
      mode: TrellageMode.Container,
      launcher: "trellage",
      name: "claude-council",
      description: "Multi-agent council.",
      sandbox: true,
      headless: COMPATIBLE_CONTAINER_HEADLESS,
    });
    expect(profiles).toContainEqual({
      harness: TrellageHarness.Copilot,
      mode: TrellageMode.Native,
      launcher: "cpx",
      name: "hve",
      description: "HVE profile.",
      sandbox: false,
    });
    expect(profiles.filter((profile) => profile.harness === TrellageHarness.Claude)).toHaveLength(
      1,
    );
  });

  it("degrades a broken launcher without losing the healthy ones", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trx list --json": TRX_LIST,
        "trellage list --json --full": "not json",
      }),
    );

    expect(profiles).toHaveLength(5);
    expect(profiles.every((profile) => profile.mode === TrellageMode.Native)).toBe(true);
  });

  it("falls back to launcher JSON when trx cannot aggregate the installed catalogs", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trx list --json": "not json",
        "cpx list --json": CPX_LIST,
      }),
    );

    expect(profiles).toEqual([
      {
        harness: TrellageHarness.Copilot,
        mode: TrellageMode.Native,
        launcher: "cpx",
        name: "hve",
        description: "HVE profile.",
        sandbox: true,
      },
    ]);
  });

  it("falls back to basic container inventory without granting headless capability", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json --full": "not json",
        "trellage list --json": CONTAINER_BASIC_LIST,
      }),
    );

    expect(profiles).toHaveLength(2);
    expect(profiles.every((profile) => profile.headless === undefined)).toBe(true);
    expect(selectRlmTrellageProfiles(profiles)).toEqual([]);
  });

  it("keeps profiles with missing or malformed headless metadata out of RLM selection", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json --full": JSON.stringify({
          profiles: [
            { name: "missing-headless", description: "", sandbox: true },
            {
              name: "malformed-headless",
              description: "",
              sandbox: true,
              headless: { prompt: "yes", outputFormats: "jsonl" },
            },
          ],
        }),
      }),
    );

    expect(profiles.map((profile) => profile.name)).toEqual([
      "missing-headless",
      "malformed-headless",
    ]);
    expect(profiles.every((profile) => profile.headless === undefined)).toBe(true);
    expect(selectRlmTrellageProfiles(profiles)).toEqual([]);
  });

  it("returns nothing when no launcher is installed", async () => {
    await expect(discoverTrellageProfiles(createRunner({}))).resolves.toEqual([]);
  });
});

describe("buildTrellageCommand", () => {
  it("passes container profiles with --profile", async () => {
    const [profile] = await discoverTrellageProfiles(
      createRunner({ "trellage list --json --full": CONTAINER_FULL_LIST }),
    );

    expect(buildTrellageCommand(profile!)).toEqual(["trellage", "--profile", "claude-council"]);
  });

  it("passes the profile positionally for launchers that accept one", async () => {
    const profiles = await discoverTrellageProfiles(createRunner({ "trx list --json": TRX_LIST }));
    const profile = profiles.find((candidate) => candidate.launcher === "cpx");

    expect(buildTrellageCommand(profile!)).toEqual(["cpx", "hve"]);
    expect(buildTrellageCommand(profile!, "gpt-5.6-sol")).toEqual([
      "cpx",
      "hve",
      "--model",
      "gpt-5.6-sol",
    ]);
    expect(buildTrellageCommand(profile!, undefined, undefined, true, 25)).toEqual([
      "cpx",
      "hve",
      "--autopilot",
      "--allow-all",
      "--max-autopilot-continues",
      "25",
    ]);
    expect(buildTrellageCommand(profile!, undefined, undefined, true)).toEqual([
      "cpx",
      "hve",
      "--autopilot",
      "--allow-all",
    ]);
  });

  it("passes default profiles positionally under the TRX launcher contract", async () => {
    const profiles = await discoverTrellageProfiles(createRunner({ "trx list --json": TRX_LIST }));
    const profile = profiles.find((candidate) => candidate.launcher === "cldx");

    expect(buildTrellageCommand(profile!)).toEqual(["cldx", "default"]);
    expect(buildTrellageCommand(profile!, "claude-opus-5", "xhigh")).toEqual([
      "cldx",
      "default",
      "--model",
      "claude-opus-5",
      "--effort",
      "xhigh",
    ]);
  });

  it("adds question-tool denial only to RLM headless native commands", async () => {
    const profiles = await discoverTrellageProfiles(createRunner({ "trx list --json": TRX_LIST }));
    const copilot = profiles.find((profile) => profile.launcher === "cpx")!;
    const claude = profiles.find((profile) => profile.launcher === "cldx")!;
    const ompCopilot = profiles.find(
      (profile) => profile.launcher === "omp" && profile.name === "copilot",
    )!;
    const ompLocal = profiles.find(
      (profile) => profile.launcher === "omp" && profile.name === "local",
    )!;

    expect(supportsHeadlessTrellage(copilot)).toBe(true);
    expect(supportsHeadlessTrellage(claude)).toBe(true);
    expect(supportsHeadlessTrellage(ompCopilot)).toBe(true);
    expect(supportsHeadlessTrellage(ompLocal)).toBe(false);
    expect(buildTrellageCommand(copilot)).not.toContain("--no-ask-user");
    expect(buildTrellageCommand(claude)).not.toContain("--disallowedTools");
    expect(buildTrellageCommand(ompCopilot)).toEqual(["omp", "copilot"]);
    expect(buildTrellageCommand(ompCopilot)).not.toContain("--exclude-tools=ask_question");
    expect(buildHeadlessTrellageCommand(copilot, { prompt: "do it" })).toEqual(
      expect.arrayContaining(["--output-format", "json", "--allow-all", "--no-ask-user"]),
    );
    expect(buildHeadlessTrellageCommand(claude, { prompt: "do it" })).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--disallowedTools",
        "AskUserQuestion",
      ]),
    );
    expect(
      buildHeadlessTrellageCommand(claude, {
        prompt: "do it",
        appendSystemPrompt: "System directive",
      }),
    ).toEqual(
      expect.arrayContaining(["--append-system-prompt", "System directive", "-p", "do it"]),
    );
    expect(buildHeadlessTrellageCommand(ompCopilot, { prompt: "do it" })).toEqual([
      "omp",
      "copilot",
      "-p",
      "do it",
      "--mode=json",
      "--approval-mode=yolo",
    ]);
    expect(
      buildHeadlessTrellageCommand(ompCopilot, {
        prompt: "resume it",
        resumeSessionId: "omp-copilot-session-1",
      }),
    ).toEqual([
      "omp",
      "copilot",
      "--resume=omp-copilot-session-1",
      "-p",
      "resume it",
      "--mode=json",
      "--approval-mode=yolo",
    ]);
    expect(() => buildHeadlessTrellageCommand(ompLocal, { prompt: "do it" })).toThrow(
      "Headless Trellage is not available for native/omp/local.",
    );
    expect(() =>
      buildHeadlessTrellageCommand(copilot, {
        prompt: "do it",
        appendSystemPrompt: "System directive",
      }),
    ).toThrow("append-system-prompt transport is unavailable for native/cpx/hve.");
  });

  it("selects compatible metadata and ignores a misleading claude-prefixed profile", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json --full": CONTAINER_FULL_LIST,
        "trx list --json": TRX_LIST,
      }),
    );

    expect(
      selectRlmTrellageProfiles(profiles).map((profile) => [profile.launcher, profile.name]),
    ).toEqual([
      ["trellage", "claude-council"],
      ["cpx", "hve"],
      ["cldx", "default"],
      ["omp", "copilot"],
    ]);
  });

  it("drives a Claude container through the exec-only JSONL contract", async () => {
    // The command builder uses the transport promised by the authoritative metadata.
    const profiles = await discoverTrellageProfiles(
      createRunner({ "trellage list --json --full": CONTAINER_FULL_LIST }),
    );
    const claudeContainer = profiles.find((profile) => profile.name === "claude-council")!;
    const unsupportedContainer = profiles.find((profile) => profile.name === "claude-legacy")!;

    expect(supportsHeadlessTrellage(claudeContainer)).toBe(true);
    expect(headlessCapabilitiesFor(claudeContainer)).toEqual({
      structuredEvents: true,
      resume: true,
      denyQuestionTool: true,
      changedFiles: true,
      cost: true,
    });
    expect(supportsHeadlessTrellage(unsupportedContainer)).toBe(false);
    expect(buildHeadlessTrellageCommand(claudeContainer, { prompt: "do it" })).toEqual([
      "trellage",
      "--profile",
      "claude-council",
      "--output-format",
      "jsonl",
      "--prompt",
      "do it",
    ]);
    expect(
      buildHeadlessTrellageCommand(claudeContainer, {
        prompt: "resume it",
        resumeSessionId: "12e4f707-dc7e-44c7-b576-2b57e468d6a4",
      }),
    ).toEqual([
      "trellage",
      "resume",
      "--profile",
      "claude-council",
      "12e4f707-dc7e-44c7-b576-2b57e468d6a4",
      "--output-format",
      "jsonl",
      "--prompt",
      "resume it",
    ]);
    // The container's own harness flags come from its profile definition, so no `--model`,
    // `--effort`, or question-tool flag can be injected here.
    expect(buildHeadlessTrellageCommand(claudeContainer, { prompt: "do it" })).not.toContain(
      "--disallowedTools",
    );
    expect(() => buildHeadlessTrellageCommand(unsupportedContainer, { prompt: "do it" })).toThrow(
      "Headless Trellage is not available for container/trellage/claude-legacy.",
    );
    expect(() =>
      buildHeadlessTrellageCommand(claudeContainer, {
        prompt: "do it",
        appendSystemPrompt: "System directive",
      }),
    ).toThrow("append-system-prompt transport is unavailable for container headless execution.");
  });

  it("parses Claude container output with the native Claude adapter", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({ "trellage list --json --full": CONTAINER_FULL_LIST }),
    );
    const claudeContainer = profiles.find((profile) => profile.name === "claude-council")!;

    expect(headlessAdapterFor(claudeContainer)).toBe(claudeHeadlessAdapter);
    expect(() =>
      headlessAdapterFor(profiles.find((profile) => profile.name === "claude-legacy")!),
    ).toThrow('No headless adapter is registered for container profile "claude-legacy".');
  });

  it("selects the container adapter by event contract instead of profile name", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json --full": JSON.stringify({
          profiles: [
            {
              name: "custom-runtime",
              description: "Non-Claude name with Claude events.",
              sandbox: true,
              headless: {
                ...COMPATIBLE_CONTAINER_HEADLESS,
                changedFiles: "none",
                usage: false,
                cost: false,
              },
            },
            {
              name: "claude-unknown-events",
              description: "Unknown event contract.",
              sandbox: true,
              headless: {
                ...COMPATIBLE_CONTAINER_HEADLESS,
                eventContract: "unknown-events-v1",
              },
            },
          ],
        }),
      }),
    );
    const customRuntime = profiles.find((profile) => profile.name === "custom-runtime")!;
    const unknownEvents = profiles.find((profile) => profile.name === "claude-unknown-events")!;

    expect(selectRlmTrellageProfiles(profiles)).toEqual([customRuntime]);
    expect(customRuntime.headless?.usage).toBe(false);
    expect(headlessCapabilitiesFor(customRuntime)).toMatchObject({
      changedFiles: false,
      cost: false,
    });
    expect(headlessAdapterFor(customRuntime)).toBe(claudeHeadlessAdapter);
    expect(() => headlessAdapterFor(unknownEvents)).toThrow(
      'No headless adapter is registered for container profile "claude-unknown-events".',
    );
  });

  it("orders equally suitable choices by sandboxed native, container, unsandboxed native", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json --full": CONTAINER_FULL_LIST,
        "trx list --json": TRX_LIST,
      }),
    );

    expect(
      profiles.map((profile) => `${profile.mode}:${profile.sandbox}:${profile.launcher}`),
    ).toEqual([
      "native:true:grx",
      "container:true:trellage",
      "container:true:trellage",
      "native:false:cpx",
      "native:false:cldx",
      "native:false:omp",
      "native:false:omp",
    ]);
  });
});

describe("createTrellageCatalog", () => {
  it("rejects a profile that does not belong to the requested harness", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trx list --json": TRX_LIST,
        "trellage list --json --full": CONTAINER_FULL_LIST,
      }),
    );
    const catalog = createTrellageCatalog(profiles);

    expect(() => catalog.resolve(TrellageHarness.Copilot, "claude-council")).toThrow(
      TrellageUnknownProfileError,
    );
    expect(catalog.resolve(TrellageHarness.Copilot, "hve").launcher).toBe("cpx");
  });

  it("reports native readiness and caches the probe", async () => {
    let probes = 0;
    const runner: TrellageCommandRunner = async (command, _args) => {
      if (command === "trx") return { stdout: TRX_LIST };
      if (command === "trellage") throw new Error("trellage unavailable");
      probes += 1;
      return { stdout: JSON.stringify({ readiness: "unhealthy" }) };
    };
    const catalog = createTrellageCatalog(await discoverTrellageProfiles(runner), runner);
    const profile = catalog.resolve(TrellageHarness.Copilot, "hve");

    await expect(catalog.readiness(profile)).resolves.toBe("unhealthy");
    await expect(catalog.readiness(profile)).resolves.toBe("unhealthy");
    expect(probes).toBe(1);
  });

  it("reports no readiness for container profiles, which have no inventory command", async () => {
    const runner = createRunner({ "trellage list --json --full": CONTAINER_FULL_LIST });
    const catalog = createTrellageCatalog(await discoverTrellageProfiles(runner), runner);

    await expect(
      catalog.readiness(catalog.resolve(TrellageHarness.Container, "claude-council")),
    ).resolves.toBeUndefined();
  });

  it("treats an unanswerable readiness probe as unknown rather than unhealthy", async () => {
    const runner: TrellageCommandRunner = async (_command, args) => {
      if (args[0] === "list") return { stdout: TRX_LIST };
      throw new Error("unknown subcommand: inventory");
    };
    const catalog = createTrellageCatalog(await discoverTrellageProfiles(runner), runner);

    await expect(
      catalog.readiness(catalog.resolve(TrellageHarness.Copilot, "hve")),
    ).resolves.toBeUndefined();
  });
});
