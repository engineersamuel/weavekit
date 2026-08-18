import { b } from "../../generated/baml_client/index.js";
import type { RlmStoryboardRenderer } from "./contracts.js";

/**
 * Production storyboard boundary: one structured `gemini-3.7-flash` call per observed completion.
 * The returned SVG is untrusted and must pass `sanitizeStoryboardSvg` before it is written.
 */
export const bamlRlmStoryboardRenderer: RlmStoryboardRenderer = async (request) => {
  const storyboard = await b.RenderRlmStoryboard(
    request.objective,
    request.runStatus,
    request.eventLedger,
  );
  return {
    title: storyboard.title,
    summary: storyboard.summary,
    narrative: [...storyboard.narrative],
    svg: storyboard.svg,
  };
};
