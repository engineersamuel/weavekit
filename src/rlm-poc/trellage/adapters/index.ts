import { TrellageMode, type TrellageProfile } from "../contracts.js";
import { containerRuntimeFor } from "../catalog.js";
import { claudeHeadlessAdapter } from "./claude.js";
import { copilotHeadlessAdapter } from "./copilot.js";
import { ompCopilotHeadlessAdapter } from "./omp.js";
import type { TrellageHeadlessAdapter } from "./contracts.js";

export function headlessAdapterFor(profile: TrellageProfile): TrellageHeadlessAdapter {
  if (profile.mode === TrellageMode.Container) {
    // A container emits its harness's own stream verbatim, so the Claude container reuses the
    // native `cldx` adapter unchanged. `headlessCapabilitiesFor` admits only container runtimes
    // with a verified JSONL branch, so no other runtime reaches this point.
    if (containerRuntimeFor(profile) === "claude") return claudeHeadlessAdapter;
    throw new Error(`No headless adapter is registered for container profile "${profile.name}".`);
  }
  switch (profile.launcher) {
    case "cldx":
      return claudeHeadlessAdapter;
    case "cpx":
      return copilotHeadlessAdapter;
    case "omp":
      if (profile.name === "copilot") return ompCopilotHeadlessAdapter;
      break;
    default:
      break;
  }
  throw new Error(
    `No headless adapter is registered for launcher "${profile.launcher}" and profile "${profile.name}".`,
  );
}

export type { HeadlessAdapterInput, TrellageHeadlessAdapter } from "./contracts.js";
