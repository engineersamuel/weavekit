import { describe, expect, it } from "vitest";
import { RlmStoryboardContractError } from "../../src/rlm-poc/visualization/contracts.js";
import { sanitizeStoryboardSvg } from "../../src/rlm-poc/visualization/svg.js";

const VALID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" role="img">
  <title>Run</title>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#0af" /></linearGradient></defs>
  <rect x="0" y="0" width="100" height="40" fill="url(#g)" />
  <text x="4" y="20" font-size="8">rlm d1</text>
</svg>`;

function expectRejected(svg: string, fragment: string): void {
  expect(() => sanitizeStoryboardSvg(svg)).toThrowError(RlmStoryboardContractError);
  expect(() => sanitizeStoryboardSvg(svg)).toThrowError(new RegExp(fragment, "iu"));
}

describe("sanitizeStoryboardSvg", () => {
  it("accepts a self-contained document and returns it unchanged", () => {
    expect(sanitizeStoryboardSvg(VALID)).toBe(VALID);
  });

  it("accepts local pattern transforms used by design-skill storyboards", () => {
    const patterned = VALID.replace(
      '<linearGradient id="g"><stop offset="0" stop-color="#0af" /></linearGradient>',
      '<pattern id="g" patternUnits="userSpaceOnUse" patternTransform="rotate(12)" width="8" height="8"><rect width="4" height="8" fill="#0af" /></pattern>',
    );
    expect(sanitizeStoryboardSvg(patterned)).toBe(patterned);
  });

  it("accepts text transforms used as safe SVG presentation attributes", () => {
    const transformed = VALID.replace("<text ", '<text text-transform="uppercase" ');
    expect(sanitizeStoryboardSvg(transformed)).toBe(transformed);
  });

  it("trims model chatter, code fences, comments, and prologs around the document", () => {
    const wrapped = `Here is the storyboard:\n\`\`\`svg\n<?xml version="1.0"?>\n${VALID}\n\`\`\`\nDone.`;
    expect(sanitizeStoryboardSvg(wrapped)).toBe(VALID);
  });

  it("rejects executable and embedding elements", () => {
    expectRejected(
      VALID.replace("<title>Run</title>", "<script>alert(1)</script>"),
      "contains a <script> element",
    );
    expectRejected(
      VALID.replace("<title>Run</title>", "<foreignObject><b>x</b></foreignObject>"),
      "contains a <foreignObject> element",
    );
    expectRejected(
      VALID.replace("<title>Run</title>", '<image href="https://example.com/a.png" />'),
      "contains a <image> element",
    );
  });

  it("rejects event handler attributes", () => {
    expectRejected(VALID.replace("<rect ", '<rect onload="steal()" '), "event attribute");
  });

  it("rejects malformed attributes and HTML-only named entities before rasterization", () => {
    expectRejected(VALID.replace('fill="url(#g)"', 'fill="url("#g")"'), "malformed attributes");
    expectRejected(VALID.replace("rlm d1", "rlm &bull; d1"), "unsupported XML entity");
    expect(sanitizeStoryboardSvg(VALID.replace("rlm d1", "rlm &#8226; d1"))).toContain("&#8226;");
  });

  it("rejects remote resources, disallowed schemes, and external CSS", () => {
    expectRejected(
      VALID.replace('fill="url(#g)"', 'fill="url(https://example.com/x.png)"'),
      "remote host",
    );
    expectRejected(
      VALID.replace('fill="url(#g)"', 'fill="url(data:image/png;base64,AA)"'),
      "URL scheme",
    );
    expectRejected(
      VALID.replace("<title>Run</title>", '<style>@import url("https://x/y.css");</style>'),
      "external CSS",
    );
  });

  it("requires an svg root that declares the SVG namespace and a viewBox", () => {
    expectRejected("<p>no diagram here</p>", "no <svg> document");
    expectRejected(VALID.replace(' viewBox="0 0 100 40"', ""), "must declare a viewBox");
    expectRejected(
      VALID.replace('xmlns="http://www.w3.org/2000/svg"', 'xmlns="http://example.com/ns"'),
      "namespace",
    );
  });

  it("rejects a document above the size limit", () => {
    const filler = '<rect x="0" y="0" width="1" height="1" fill="#fff" />'.repeat(9000);
    expectRejected(VALID.replace("<title>Run</title>", filler), "character limit");
  });
});
