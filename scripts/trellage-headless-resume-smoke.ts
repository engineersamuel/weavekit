#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  buildHeadlessTrellageCommand,
  discoverTrellageProfiles,
  supportsHeadlessTrellage,
} from "../src/rlm-poc/trellage/catalog.js";
import { headlessAdapterFor } from "../src/rlm-poc/trellage/adapters/index.js";
import { TrellageHarness, TrellageHeadlessTerminal } from "../src/rlm-poc/trellage/contracts.js";
import { nativeTrellageProcessRunner } from "../src/rlm-poc/trellage/headlessRunner.js";

const DEFAULT_PROFILE = "claude-council";
const TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_LENGTH = 2_048;

const profileName = readProfileName(process.argv.slice(2));
const profile = (await discoverTrellageProfiles()).find(
  (candidate) => candidate.harness === TrellageHarness.Container && candidate.name === profileName,
);
if (!profile) {
  throw new Error(`Container profile "${profileName}" was not found.`);
}
if (!supportsHeadlessTrellage(profile)) {
  throw new Error(`Container profile "${profileName}" has no compatible headless contract.`);
}

const adapter = headlessAdapterFor(profile);
const sentinelId = randomUUID();
const firstSentinel = `TRELLAGE_RESUME_FIRST_${sentinelId}`;
const secondSentinel = `TRELLAGE_RESUME_SECOND_${sentinelId}`;
const first = await runAttempt(
  buildHeadlessTrellageCommand(profile, {
    prompt: exactSentinelPrompt(firstSentinel),
  }),
);
const firstResult = adapter.parse(first);
assertCompleted(firstResult, firstSentinel, "initial");
if (!firstResult.sessionId) {
  throw new Error("Initial headless result did not provide a session ID.");
}

const second = await runAttempt(
  buildHeadlessTrellageCommand(profile, {
    prompt: exactSentinelPrompt(secondSentinel),
    resumeSessionId: firstResult.sessionId,
  }),
);
const secondResult = adapter.parse(second);
assertCompleted(secondResult, secondSentinel, "resumed");
if (secondResult.sessionId !== firstResult.sessionId) {
  throw new Error(
    `Resume changed the session ID from "${firstResult.sessionId}" to ` +
      `"${secondResult.sessionId ?? "<missing>"}".`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      profile: profile.name,
      sessionId: firstResult.sessionId,
      first: { terminal: firstResult.terminal, sentinel: firstSentinel },
      resumed: { terminal: secondResult.terminal, sentinel: secondSentinel },
    },
    null,
    2,
  )}\n`,
);

function readProfileName(args: readonly string[]): string {
  if (args.length === 0) return DEFAULT_PROFILE;
  if (args.length === 2 && args[0] === "--profile" && args[1]) return args[1];
  throw new Error(
    "Usage: nub scripts/trellage-headless-resume-smoke.ts [--profile <container-profile>]",
  );
}

function exactSentinelPrompt(sentinel: string): string {
  return `Return exactly ${sentinel}. Do not call tools and do not modify files.`;
}

async function runAttempt(argv: string[]) {
  const result = await nativeTrellageProcessRunner.run({
    argv,
    cwd: process.cwd(),
    timeoutMs: TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled) {
    throw new Error(
      `Trellage process failed: exit=${String(result.exitCode)} signal=${String(result.signal)} ` +
        `timedOut=${String(result.timedOut)} cancelled=${String(result.cancelled)} ` +
        `stderr=${bound(result.stderr)}`,
    );
  }
  return result;
}

function assertCompleted(
  result: ReturnType<typeof adapter.parse>,
  sentinel: string,
  label: string,
): void {
  if (result.terminal !== TrellageHeadlessTerminal.Completed) {
    throw new Error(
      `${label} headless result was ${result.terminal}: ${bound(
        result.harnessError ?? result.finalText ?? "no terminal text",
      )}`,
    );
  }
  if (!result.finalText?.includes(sentinel)) {
    throw new Error(`${label} headless result did not contain sentinel "${sentinel}".`);
  }
}

function bound(value: string): string {
  return value.length <= MAX_ERROR_LENGTH ? value : `${value.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}
