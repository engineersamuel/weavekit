import {
  RlmVisualizationAction,
  RlmVisualizationStatus,
  type RlmStoryboard,
  type RlmVisualizationEvent,
  type RlmVisualizationState,
} from "./contracts.js";

const MAX_LEDGER_EVENTS = 40;
const MAX_FIELD_LENGTH = 400;
const MAX_LEDGER_LENGTH = 24_000;
const MAX_FALLBACK_ROWS = 26;

/** Shortens untrusted text to a bounded, single-line form before it reaches a prompt or a document. */
export function bounded(value: string | undefined, maxLength = MAX_FIELD_LENGTH): string {
  const trimmed = (value ?? "").replace(/\s+/gu, " ").trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

/**
 * Deterministic, bounded ledger handed to the storyboard model. Only the most recent events are
 * described in full; older ones collapse to a count so the prompt cannot grow without limit.
 */
export function buildStoryboardLedger(state: RlmVisualizationState): string {
  const omitted = Math.max(0, state.events.length - MAX_LEDGER_EVENTS);
  const recent = state.events.slice(-MAX_LEDGER_EVENTS);
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(`(${omitted} earlier completed calls omitted; the run has ${state.events.length}.)`);
  }
  for (const event of recent) {
    lines.push(
      [
        `#${event.sequence} ${event.action} ${event.status}`,
        `callId=${event.callId}`,
        `parent=${event.parentCallId ?? "root-session"}`,
        `depth=${event.depth}`,
        `profile=${event.profile}`,
        ...(event.harness ? [`harness=${event.harness}`] : []),
        ...(event.model ? [`model=${event.model}`] : []),
        `durationMs=${event.durationMs}`,
        ...(event.dependencyCallIds.length
          ? [`consumes=${event.dependencyCallIds.join(",")}`]
          : []),
        ...(event.worktreePath ? [`worktree=${bounded(event.worktreePath, 160)}`] : []),
      ].join(" | "),
    );
    lines.push(`  action: ${bounded(event.prompt)}`);
    if (event.summary) lines.push(`  result: ${bounded(event.summary)}`);
    for (const decision of event.decisions.slice(0, 6)) {
      lines.push(`  decision: ${bounded(decision, 200)}`);
    }
    for (const artifact of event.artifacts.slice(0, 6)) {
      lines.push(`  artifact: ${bounded(artifact, 200)}`);
    }
    if (event.error) lines.push(`  failure: ${bounded(event.error)}`);
  }
  if (lines.length === 0) lines.push("(no completed calls yet)");
  const ledger = lines.join("\n");
  return ledger.length > MAX_LEDGER_LENGTH ? ledger.slice(-MAX_LEDGER_LENGTH) : ledger;
}

/**
 * Locally drawn storyboard used when the model boundary or the SVG contract fails, so the run
 * always has a viewable, rasterizable artifact instead of an empty one.
 */
export function buildFallbackStoryboard(state: RlmVisualizationState): RlmStoryboard {
  const rows = state.events.slice(-MAX_FALLBACK_ROWS);
  const rowHeight = 34;
  const top = 128;
  const height = top + Math.max(rows.length, 1) * rowHeight + 48;
  const width = 1400;
  const body = rows.map((event, index) => fallbackRow(event, top + index * rowHeight, width));
  const ledgerLabel = state.diagnostics.some(
    (diagnostic) => diagnostic.stage === "render" || diagnostic.stage === "contract",
  )
    ? "FALLBACK LEDGER — the model storyboard was unavailable"
    : "LIVE LEDGER — model storyboard pending";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<title>${xml(state.objective ? bounded(state.objective, 120) : state.runId)}</title>`,
    `<desc>Deterministic fallback storyboard for RLM run ${xml(state.runId)}.</desc>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#0b0f14"/>`,
    `<rect x="0" y="0" width="${width}" height="72" fill="#111820"/>`,
    `<text x="32" y="34" fill="#e6edf3" font-family="monospace" font-size="20">RLM RUN ${xml(state.runId.toUpperCase())}</text>`,
    `<text x="32" y="58" fill="#8b98a5" font-family="monospace" font-size="13">${xml(bounded(state.objective, 150))}</text>`,
    `<text x="${width - 32}" y="34" text-anchor="end" font-family="monospace" font-size="16" fill="${statusColor(state.runStatus)}">${xml(state.runStatus.toUpperCase())}</text>`,
    `<text x="${width - 32}" y="58" text-anchor="end" font-family="monospace" font-size="12" fill="#8b98a5">rev ${state.revision} · ${state.events.length} calls</text>`,
    `<text x="32" y="104" fill="#f0b429" font-family="monospace" font-size="13">${ledgerLabel}</text>`,
    ...body,
    `</svg>`,
  ].join("");
  return {
    title: `RLM run ${state.runId}`,
    summary: state.runSummary
      ? bounded(state.runSummary, 1200)
      : `${state.events.length} completed delegations. Run status: ${state.runStatus}.`,
    narrative: rows.map(
      (event) =>
        `#${event.sequence} ${event.action} ${event.status} at depth ${event.depth}: ${bounded(event.prompt, 160)}`,
    ),
    svg,
  };
}

function fallbackRow(event: RlmVisualizationEvent, y: number, width: number): string {
  const indent = 32 + Math.min(event.depth - 1, 6) * 26;
  const color =
    event.status === RlmVisualizationStatus.Succeeded ? "#3fb950" : /* failed */ "#f85149";
  const label = event.action === RlmVisualizationAction.Rlm ? "rlm" : "trellage";
  return [
    `<rect x="${indent}" y="${y}" width="${width - indent - 32}" height="26" fill="#151c24" rx="3"/>`,
    `<rect x="${indent}" y="${y}" width="4" height="26" fill="${color}"/>`,
    `<text x="${indent + 14}" y="${y + 18}" fill="#8b98a5" font-family="monospace" font-size="12">#${event.sequence} ${xml(label)}</text>`,
    `<text x="${indent + 130}" y="${y + 18}" fill="#e6edf3" font-family="monospace" font-size="12">${xml(bounded(event.prompt, 110))}</text>`,
    `<text x="${width - 44}" y="${y + 18}" text-anchor="end" fill="${color}" font-family="monospace" font-size="12">${xml(event.status)}</text>`,
  ].join("");
}

function statusColor(status: string): string {
  if (status === "succeeded") return "#3fb950";
  if (status === "failed") return "#f85149";
  return "#58a6ff";
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
