import type { RlmStoryboardRasterizer } from "./contracts.js";

/** Width the PNG is rasterized to. Wide enough to stay legible in a Kitty image preview. */
const PNG_WIDTH = 1600;

/**
 * Deterministic SVG to PNG conversion. `@resvg/resvg-js` renders in-process with no browser and no
 * network, so the PNG is always produced from exactly the SVG that the HTML page embeds.
 *
 * The import is lazy: a run whose visualization is disabled never loads the native addon.
 */
export const resvgStoryboardRasterizer: RlmStoryboardRasterizer = async (svg) => {
  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    background: "#080b0f",
    fitTo: { mode: "width", value: PNG_WIDTH },
    font: { loadSystemFonts: true },
  });
  return renderer.render().asPng();
};
