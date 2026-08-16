import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  TrellageHarness,
  TrellageMode,
  TrellageUnknownProfileError,
  type TrellageHeadlessCapabilities,
  type TrellageProfile,
} from "./contracts.js";

const execFileAsync = promisify(execFile);

const DISCOVERY_TIMEOUT_MS = 20_000;

const FALLBACK_NATIVE_LAUNCHERS: Readonly<Record<string, TrellageHarness>> = {
  cpx: TrellageHarness.Copilot,
  grx: TrellageHarness.Grok,
  cdx: TrellageHarness.Codex,
  cldx: TrellageHarness.Claude,
  prx: TrellageHarness.Prime,
  jcx: TrellageHarness.Jcode,
  omp: TrellageHarness.OhMyPi,
};

const ProfileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(""),
    sandbox: z.boolean().optional(),
  })
  .passthrough();

/** Container mode: `{ schemaVersion, profiles: [...] }` — no per-profile harness/launcher. */
const ContainerCatalogSchema = z.object({
  profiles: z.array(ProfileSchema).default([]),
});

/** `trx list --json` reports every native launcher in one canonical inventory. */
const NativeCatalogSchema = z.object({
  profiles: z
    .array(
      ProfileSchema.extend({
        harness: z.string().min(1),
        launcher: z.string().min(1),
      }),
    )
    .default([]),
});

/** Individual launcher shape used when `trx` cannot aggregate its installed catalogs. */
const NativeLauncherCatalogSchema = z.object({
  harness: z.string().min(1),
  launcher: z.string().min(1),
  sandbox: z.boolean().optional(),
  profiles: z.array(ProfileSchema).default([]),
});

const InventorySchema = z.object({ readiness: z.string().min(1).optional() }).passthrough();

export type TrellageCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string }>;

export type TrellageCatalog = {
  list(): readonly TrellageProfile[];
  resolve(harness: string, profile: string): TrellageProfile;
  /** Queries `inventory --json` readiness for a native profile; container mode has no equivalent. */
  readiness(profile: TrellageProfile): Promise<string | undefined>;
};

const defaultRunner: TrellageCommandRunner = (command, args) =>
  execFileAsync(command, args, { encoding: "utf8", timeout: DISCOVERY_TIMEOUT_MS });

/**
 * Discovers every installed Trellage profile from the two canonical JSON inventories.
 *
 * Either inventory may be missing or malformed without suppressing the other. The normalized list
 * is safety-ordered for equally suitable profiles: sandboxed native, container, unsandboxed native.
 */
export async function discoverTrellageProfiles(
  runner: TrellageCommandRunner = defaultRunner,
): Promise<TrellageProfile[]> {
  const discovered = (
    await Promise.all([discoverContainerProfiles(runner), discoverNativeProfiles(runner)])
  ).flat();
  return discovered.sort((left, right) => safetyRank(left) - safetyRank(right));
}

async function discoverContainerProfiles(
  runner: TrellageCommandRunner,
): Promise<TrellageProfile[]> {
  try {
    const { stdout } = await runner("trellage", ["list", "--json"]);
    const parsed = ContainerCatalogSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return [];
    return parsed.data.profiles.map((profile) => ({
      harness: TrellageHarness.Container,
      mode: TrellageMode.Container,
      launcher: "trellage",
      name: profile.name,
      description: profile.description,
      sandbox: profile.sandbox ?? false,
    }));
  } catch {
    return [];
  }
}

async function discoverNativeProfiles(runner: TrellageCommandRunner): Promise<TrellageProfile[]> {
  try {
    const { stdout } = await runner("trx", ["list", "--json"]);
    const parsed = NativeCatalogSchema.safeParse(JSON.parse(stdout));
    if (parsed.success && parsed.data.profiles.length > 0) {
      return normalizeNativeProfiles(parsed.data.profiles);
    }
  } catch {
    // Fall through to the isolated launcher catalogs so one aggregator failure loses no profiles.
  }

  const catalogs = await Promise.all(
    Object.entries(FALLBACK_NATIVE_LAUNCHERS).map(async ([launcher, expectedHarness]) => {
      try {
        const { stdout } = await runner(launcher, ["list", "--json"]);
        const parsed = NativeLauncherCatalogSchema.safeParse(JSON.parse(stdout));
        if (
          !parsed.success ||
          parsed.data.launcher !== launcher ||
          parsed.data.harness !== expectedHarness
        ) {
          return [];
        }
        return normalizeNativeProfiles(
          parsed.data.profiles.map((profile) => ({
            ...profile,
            launcher,
            harness: expectedHarness,
            sandbox: profile.sandbox ?? parsed.data.sandbox,
          })),
        );
      } catch {
        return [];
      }
    }),
  );
  return catalogs.flat();
}

function normalizeNativeProfiles(
  profiles: Readonly<z.infer<typeof NativeCatalogSchema>["profiles"]>,
): TrellageProfile[] {
  return profiles.flatMap((profile) => {
    if (!isTrellageHarness(profile.harness) || profile.harness === TrellageHarness.Container) {
      return [];
    }
    return [
      {
        harness: profile.harness,
        mode: TrellageMode.Native,
        launcher: profile.launcher,
        name: profile.name,
        description: profile.description,
        sandbox: profile.sandbox ?? false,
      },
    ];
  });
}

function safetyRank(profile: TrellageProfile): number {
  if (profile.mode === TrellageMode.Native && profile.sandbox) return 0;
  if (profile.mode === TrellageMode.Container) return 1;
  return 2;
}

function isTrellageHarness(value: string): value is TrellageHarness {
  return Object.values(TrellageHarness).some((harness) => harness === value);
}

/**
 * Builds the argv used to launch a profile in a PTY.
 *
 * Container mode is `trellage --profile <name>`. TRX's native launcher contract is
 * `<launcher> <profile>`, including launchers whose only current profile is named `default`.
 */
export function buildTrellageCommand(
  profile: TrellageProfile,
  model?: string,
  effort?: string,
  autopilot?: boolean,
  maxAutopilotContinues?: number,
): string[] {
  if (profile.mode === TrellageMode.Container) {
    return ["trellage", "--profile", profile.name];
  }
  const command = [profile.launcher, profile.name];
  if (model) command.push("--model", model);
  if (effort) command.push("--effort", effort);
  if (autopilot) {
    command.push("--autopilot", "--allow-all");
    if (maxAutopilotContinues) {
      command.push("--max-autopilot-continues", String(maxAutopilotContinues));
    }
  }
  return command;
}

const NATIVE_HEADLESS_CAPABILITIES: Readonly<
  Record<string, TrellageHeadlessCapabilities | undefined>
> = {
  cldx: {
    structuredEvents: true,
    resume: true,
    denyQuestionTool: true,
    changedFiles: false,
    cost: true,
  },
  cpx: {
    structuredEvents: true,
    resume: true,
    denyQuestionTool: true,
    changedFiles: true,
    cost: true,
  },
  "omp:copilot": {
    structuredEvents: true,
    resume: true,
    denyQuestionTool: true,
    changedFiles: false,
    cost: false,
  },
};

/**
 * Container harness runtimes with a verified headless JSONL contract.
 *
 * Only the Claude container runtime implements the `TRELLAGE_OUTPUT_FORMAT=jsonl` branch, where it
 * appends `--output-format stream-json --verbose` to Claude Code's own args. The emitted events are
 * therefore identical to native `cldx`, so they reuse the same adapter. `denyQuestionTool` holds
 * without passing `--disallowedTools`: Claude Code's non-interactive `-p` mode does not expose
 * `AskUserQuestion` at all. `changedFiles` matches `cldx` — Claude's stream-json does not report
 * them.
 *
 * Trellage names each container profile `<harness kind>-<suite>` and derives the container name
 * from the same kind, so the prefix identifies the runtime. A wrong guess fails closed: a runtime
 * without the JSONL branch emits text, which the adapter reports as malformed.
 */
const CONTAINER_HEADLESS_RUNTIMES: Readonly<
  Record<string, TrellageHeadlessCapabilities | undefined>
> = {
  claude: {
    structuredEvents: true,
    resume: true,
    denyQuestionTool: true,
    changedFiles: false,
    cost: true,
  },
};

/**
 * Launchers blocked from RLM selection even if an adapter is added.
 *
 * `grx` remains excluded until upstream Grok OAuth/profile compatibility is fixed and its normal
 * wrapper path passes live contract tests without a model override.
 */
const RLM_DISABLED_LAUNCHERS = new Set(["grx"]);

/** Resolves the container harness runtime that owns a container profile. */
export function containerRuntimeFor(profile: TrellageProfile): string | undefined {
  const [runtime] = profile.name.split("-");
  return runtime || undefined;
}

/**
 * Returns capabilities only for launchers and container runtimes with a verified headless adapter.
 */
export function headlessCapabilitiesFor(
  profile: TrellageProfile,
): TrellageHeadlessCapabilities | undefined {
  if (profile.mode === TrellageMode.Container) {
    const runtime = containerRuntimeFor(profile);
    return runtime ? CONTAINER_HEADLESS_RUNTIMES[runtime] : undefined;
  }
  return (
    NATIVE_HEADLESS_CAPABILITIES[`${profile.launcher}:${profile.name}`] ??
    NATIVE_HEADLESS_CAPABILITIES[profile.launcher]
  );
}

export function supportsHeadlessTrellage(profile: TrellageProfile): boolean {
  const capabilities = headlessCapabilitiesFor(profile);
  return Boolean(
    capabilities?.structuredEvents && capabilities.resume && capabilities.denyQuestionTool,
  );
}

/**
 * Profiles exposed to `invoke_trellage`.
 *
 * Discovery still reads the complete Trellage/TRX inventory, but the RLM can select only launchers
 * and container runtimes with a verified structured adapter. Keep this restriction until the
 * remaining launchers and container runtimes pass their fixture, contract, and profile-sweep gates.
 */
export function selectRlmTrellageProfiles(profiles: readonly TrellageProfile[]): TrellageProfile[] {
  return profiles.filter(
    (profile) => !RLM_DISABLED_LAUNCHERS.has(profile.launcher) && supportsHeadlessTrellage(profile),
  );
}

export type TrellageHeadlessCommandOptions = {
  prompt: string;
  model?: string;
  effort?: string;
  autopilot?: boolean;
  maxAutopilotContinues?: number;
  resumeSessionId?: string;
};

/**
 * Builds RLM-only non-interactive argv for verified native launchers.
 *
 * The interactive `buildTrellageCommand` remains unchanged for manual use and for the retained
 * PTY path. In particular, question-tool denial belongs only to this RLM-owned invocation.
 */
export function buildHeadlessTrellageCommand(
  profile: TrellageProfile,
  options: TrellageHeadlessCommandOptions,
): string[] {
  if (!supportsHeadlessTrellage(profile)) {
    throw new Error(
      `Headless Trellage is not available for ${profile.mode}/${profile.launcher}/${profile.name}.`,
    );
  }

  if (profile.mode === TrellageMode.Container) {
    // `trellage` exempts `--prompt`, `resume … --prompt`, and `--output-format jsonl` from its
    // interactive-terminal assertion, and drops `--interactive --tty` from `docker container exec`
    // for JSONL. The harness's own flags come from the profile definition and cannot be passed
    // here, so the runtime entry supplies them from `TRELLAGE_OUTPUT_FORMAT`. Model and effort
    // overrides are rejected for containers before reaching this point.
    const container = ["trellage"];
    if (options.resumeSessionId) {
      container.push("resume", "--profile", profile.name, options.resumeSessionId);
    } else {
      container.push("--profile", profile.name);
    }
    container.push("--output-format", "jsonl", "--prompt", options.prompt);
    return container;
  }

  const command = [profile.launcher, profile.name];
  if (options.model) command.push("--model", options.model);
  if (options.effort) command.push("--effort", options.effort);

  if (profile.launcher === "cldx") {
    if (options.resumeSessionId) command.push("--resume", options.resumeSessionId);
    command.push(
      "-p",
      options.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--disallowedTools",
      "AskUserQuestion",
    );
    return command;
  }

  if (profile.launcher === "omp" && profile.name === "copilot") {
    if (options.resumeSessionId) command.push(`--resume=${options.resumeSessionId}`);
    command.push("-p", options.prompt, "--mode=json", "--approval-mode=yolo");
    return command;
  }

  if (options.resumeSessionId) command.push("--resume", options.resumeSessionId);
  if (options.autopilot) {
    command.push("--autopilot");
    if (options.maxAutopilotContinues) {
      command.push("--max-autopilot-continues", String(options.maxAutopilotContinues));
    }
  }
  command.push("-p", options.prompt, "--output-format", "json", "--allow-all", "--no-ask-user");
  return command;
}

/**
 * Creates a catalog over an already-discovered profile list, caching readiness lookups per
 * process so repeated invocations of the same profile do not re-shell out.
 */
export function createTrellageCatalog(
  profiles: readonly TrellageProfile[],
  runner: TrellageCommandRunner = defaultRunner,
): TrellageCatalog {
  const readinessCache = new Map<string, Promise<string | undefined>>();
  return {
    list: () => profiles,
    resolve(harness, profile) {
      const found = profiles.find(
        (candidate) => candidate.harness === harness && candidate.name === profile,
      );
      if (!found) throw new TrellageUnknownProfileError(harness, profile);
      return found;
    },
    readiness(profile) {
      if (profile.mode === TrellageMode.Container) return Promise.resolve(undefined);
      const key = `${profile.launcher}:${profile.name}`;
      const cached = readinessCache.get(key);
      if (cached) return cached;
      const pending = queryReadiness(profile, runner);
      readinessCache.set(key, pending);
      return pending;
    },
  };
}

async function queryReadiness(
  profile: TrellageProfile,
  runner: TrellageCommandRunner,
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(profile.launcher, ["inventory", profile.name, "--json"]);
    const parsed = InventorySchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.readiness : undefined;
  } catch {
    // A launcher without an `inventory` subcommand, or one that fails to answer, is treated as
    // "readiness unknown" rather than unhealthy: refusing to launch on a failed *probe* would be
    // more disruptive than letting the launch itself report the real problem.
    return undefined;
  }
}
