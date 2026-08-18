// Continual storyboard rendering for the recursive RLM run (see docs/adr/0014-rlm-run-storyboard.md).
// One call per observed `rlm` / `invoke_trellage` completion, so the prompt must stay small and the
// output must be a self-contained SVG that the recorder can sanitize before writing it to disk.

class RlmStoryboard {
  /// Short control-room headline for the whole run, no trailing punctuation.
  title string
  /// Two to four sentences explaining what the Submind has done so far and where it stands.
  summary string
  /// Ordered narrative beats, one per meaningful action, newest last.
  narrative string[]
  /// A standalone `<svg>` document. No scripts, no network references, no embedded HTML.
  svg string
}

function RenderRlmStoryboard(
  objective: string,
  runStatus: string,
  eventLedger: string
) -> RlmStoryboard {
  client CopilotProxyGemini37Flash
  prompt #"
    {{ _.role("user") }}
    You draw the live storyboard for one recursive Submind run.

    The Submind delegates work two ways: `rlm` spawns a nested Submind session, and
    `invoke_trellage` hands a task to a different agent harness in its own git worktree.
    The ledger below lists every completed delegation in order, with its parent, so the
    recursion hierarchy is fully determined. Use only these facts. Do not invent work.

    Draw an industrial control-room storyboard that makes six things obvious at a glance:
    1. the recursion hierarchy (parent above child, indented or connected by lines),
    2. chronological progress in ledger order,
    3. the action taken by each call,
    4. the decisions recorded for each call,
    5. the information flow between calls, including dependency edges,
    6. results, failures, and the current run status.

    SVG rules, all mandatory:
    - Return exactly one `<svg>` element with `xmlns="http://www.w3.org/2000/svg"` and a `viewBox`.
    - Use only these elements: svg, g, defs, title, desc, style, linearGradient, radialGradient,
      stop, rect, circle, ellipse, line, polyline, polygon, path, text, tspan, marker.
    - Produce static, well-formed XML. Do not use animate elements. Quote every attribute exactly
      once; local marker references must look exactly like `marker-end="url(#arrow)"`.
    - Use literal UTF-8 glyphs or numeric entities such as `&#8226;`. Named HTML entities such as
      `&bull;`, `&rarr;`, and `&Delta;` are invalid in standalone SVG and are forbidden.
    - Never emit script, foreignObject, image, iframe, use, or `a` elements.
    - Never emit `on...` event attributes, external URLs, `@import`, or `url(http...)`.
    - Keep the document under 120000 characters. Prefer a dark control-room palette with
      high-contrast text, and keep every label legible at 1400 pixels wide.

    Run objective:
    {{ objective }}

    Current run status:
    {{ runStatus }}

    Completed-action ledger, oldest first:
    {{ eventLedger }}

    {{ ctx.output_format }}
  "#
}
