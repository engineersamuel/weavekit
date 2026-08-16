import { describe, expect, it } from "vitest";
import {
  buildTrellageCommand,
  buildHeadlessTrellageCommand,
  createTrellageCatalog,
  discoverTrellageProfiles,
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
const CONTAINER_LIST = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    { name: "claude-council", description: "Multi-agent council.", sandbox: true },
    { name: "codex-superpowers", description: "Codex with superpowers.", sandbox: true },
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
        "trellage list --json": CONTAINER_LIST,
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
      createRunner({ "trx list --json": TRX_LIST, "trellage list --json": "not json" }),
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

  it("returns nothing when no launcher is installed", async () => {
    await expect(discoverTrellageProfiles(createRunner({}))).resolves.toEqual([]);
  });
});

describe("buildTrellageCommand", () => {
  it("passes container profiles with --profile", async () => {
    const [profile] = await discoverTrellageProfiles(
      createRunner({ "trellage list --json": CONTAINER_LIST }),
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
  });

  it("exposes verified native and Claude container profiles while omitting grx, omp/local, and non-Claude containers", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json": CONTAINER_LIST,
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
    // Verified live: `trellage --profile claude-council --output-format jsonl --prompt ...` and its
    // `resume` form both exit 0 with Claude stream-json and a stable session ID, with stdin closed
    // and no TTY. Only the Claude container runtime implements the JSONL branch.
    const profiles = await discoverTrellageProfiles(
      createRunner({ "trellage list --json": CONTAINER_LIST }),
    );
    const claudeContainer = profiles.find((profile) => profile.name === "claude-council")!;
    const codexContainer = profiles.find((profile) => profile.name === "codex-superpowers")!;

    expect(supportsHeadlessTrellage(claudeContainer)).toBe(true);
    expect(supportsHeadlessTrellage(codexContainer)).toBe(false);
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
    expect(() => buildHeadlessTrellageCommand(codexContainer, { prompt: "do it" })).toThrow(
      "Headless Trellage is not available for container/trellage/codex-superpowers.",
    );
  });

  it("parses Claude container output with the native Claude adapter", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({ "trellage list --json": CONTAINER_LIST }),
    );
    const claudeContainer = profiles.find((profile) => profile.name === "claude-council")!;

    expect(headlessAdapterFor(claudeContainer)).toBe(claudeHeadlessAdapter);
    expect(() =>
      headlessAdapterFor(profiles.find((profile) => profile.name === "codex-superpowers")!),
    ).toThrow('No headless adapter is registered for container profile "codex-superpowers".');
  });

  it("orders equally suitable choices by sandboxed native, container, unsandboxed native", async () => {
    const profiles = await discoverTrellageProfiles(
      createRunner({
        "trellage list --json": CONTAINER_LIST,
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
      createRunner({ "trx list --json": TRX_LIST, "trellage list --json": CONTAINER_LIST }),
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
    const runner = createRunner({ "trellage list --json": CONTAINER_LIST });
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
