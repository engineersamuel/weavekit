import { buildLangfuseTraceUrl } from "../mastermind/telemetry.js";
import type { SubmindRunState } from "./contracts.js";

export function buildSubmindRunFooter(state: SubmindRunState, traceId: string): string {
  const orchestratorName = `${state.agentPrefix}orchestrator`;
  const resume = state.orchestratorAgentId
    ? `herdr agent attach ${shellQuote(orchestratorName)}`
    : "unavailable because the orchestrator has not been launched";
  const traceUrl = buildLangfuseTraceUrl(traceId);
  const trace = traceUrl ? traceUrl : `${traceId} (set LANGFUSE_PROJECT_ID to print a direct URL)`;

  return `\nResume conversation: ${resume}\nLangfuse trace: ${trace}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
