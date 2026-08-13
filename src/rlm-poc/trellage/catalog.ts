import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  TrellageHarness,
  TrellageMode,
  TrellageUnknownProfileError,
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
): string[] {
  if (profile.mode === TrellageMode.Container) {
    return ["trellage", "--profile", profile.name];
  }
  const command = [profile.launcher, profile.name];
  if (model) command.push("--model", model);
  if (effort) command.push("--effort", effort);
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
