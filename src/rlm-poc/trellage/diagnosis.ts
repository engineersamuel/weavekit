import {
  b,
  TrellageTurnOutcome,
  type TrellageTurnDiagnosis as BamlTrellageTurnDiagnosis,
} from "../../generated/baml_client/index.js";
import type { TrellageHeadlessResult } from "./contracts.js";

const TRELLAGE_DIAGNOSIS_ENV = {
  COPILOT_PROXY_API_KEY: process.env.COPILOT_PROXY_API_KEY ?? "rlm-trellage-diagnosis-local-proxy",
} as const;

export type TrellageDiagnosisInput = {
  originalGoal: string;
  result: TrellageHeadlessResult;
};

export type TrellageTurnDiagnoser = {
  diagnose(input: TrellageDiagnosisInput): Promise<BamlTrellageTurnDiagnosis>;
};

/**
 * Uses the repository-standard BAML client for the only semantic decision in the headless path.
 * It intentionally has no heuristic fallback: unavailable or malformed diagnosis is a failed
 * invocation, not success by implication.
 */
export const bamlTrellageTurnDiagnoser: TrellageTurnDiagnoser = {
  async diagnose(input: TrellageDiagnosisInput): Promise<BamlTrellageTurnDiagnosis> {
    const diagnosis = await b.DiagnoseTrellageTurn(
      input.originalGoal,
      input.result.finalText ?? "",
      input.result.terminal,
      input.result.changedFiles,
      { env: TRELLAGE_DIAGNOSIS_ENV },
    );
    if (!Object.values(TrellageTurnOutcome).includes(diagnosis.outcome)) {
      throw new Error(`BAML returned an unsupported Trellage diagnosis "${diagnosis.outcome}".`);
    }
    if (!diagnosis.summary.trim()) {
      throw new Error("BAML returned an empty Trellage diagnosis summary.");
    }
    return diagnosis;
  },
};
