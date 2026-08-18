import { TrellageMode, type TrellageProfile } from "../contracts.js";
import { TrellageContainerEventContract } from "../catalog.js";
import { claudeHeadlessAdapter } from "./claude.js";
import { copilotHeadlessAdapter } from "./copilot.js";
import { ompCopilotHeadlessAdapter } from "./omp.js";
import type { TrellageHeadlessAdapter } from "./contracts.js";

export function headlessAdapterFor(profile: TrellageProfile): TrellageHeadlessAdapter {
  if (profile.mode === TrellageMode.Container) {
    // Trellage emits the harness stream verbatim. Route only by its authoritative event contract.
    if (profile.headless?.eventContract === TrellageContainerEventContract.ClaudeStreamJsonV1) {
      return claudeHeadlessAdapter;
    }
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
