import { RlmStoryboardContractError } from "./contracts.js";

/**
 * Elements the storyboard contract allows. Everything that can execute code (`script`), embed
 * foreign markup (`foreignObject`), or reach the network (`image`, `use`, `a`, `iframe`) is absent
 * on purpose, so an allowlist violation is a contract failure rather than something to strip.
 */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "style",
  "lineargradient",
  "radialgradient",
  "stop",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "marker",
  "clippath",
  "mask",
  "pattern",
  "symbol",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "id",
  "class",
  "style",
  "transform",
  "viewbox",
  "xmlns",
  "version",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "dx",
  "dy",
  "offset",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "opacity",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "text-decoration",
  "text-transform",
  "white-space",
  "clip-path",
  "clip-rule",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
  "markerwidth",
  "markerheight",
  "markerunits",
  "refx",
  "refy",
  "orient",
  "gradientunits",
  "gradienttransform",
  "patternunits",
  "patterncontentunits",
  "patterntransform",
  "clippathunits",
  "maskunits",
  "maskcontentunits",
  "stop-color",
  "stop-opacity",
  "preserveaspectratio",
  "shape-rendering",
  "vector-effect",
  "paint-order",
  "role",
  "lang",
]);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_SVG_LENGTH = 400_000;

const TAG_PATTERN = /<\/?([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gu;
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-\w:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gu;

/**
 * Validates untrusted model output against the storyboard SVG contract and returns the document
 * that may be written to disk. Throws {@link RlmStoryboardContractError} on any violation; the
 * recorder treats that as a non-fatal render failure and keeps the previous storyboard.
 */
export function sanitizeStoryboardSvg(raw: string): string {
  const document = extractSvgDocument(raw);
  if (document.length > MAX_SVG_LENGTH) {
    throw new RlmStoryboardContractError(
      `Storyboard SVG is ${document.length} characters, above the ${MAX_SVG_LENGTH} character limit.`,
    );
  }

  let firstElement: string | undefined;
  let rootAttributes = "";
  const withoutTags = document.replace(TAG_PATTERN, (tag, name: string, attributes: string) => {
    const element = name.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(element)) {
      throw new RlmStoryboardContractError(`Storyboard SVG contains a <${name}> element.`);
    }
    if (!firstElement) {
      firstElement = element;
      rootAttributes = attributes;
    }
    if (!tag.startsWith("</")) {
      assertAttributes(name, attributes);
    }
    return "";
  });

  if (firstElement !== "svg") {
    throw new RlmStoryboardContractError("Storyboard SVG does not start with an <svg> element.");
  }
  if (withoutTags.includes("<")) {
    throw new RlmStoryboardContractError("Storyboard SVG contains unparsable markup.");
  }
  assertXmlEntities(document);
  assertRootAttributes(rootAttributes);
  assertStyleBlocks(document);
  return document;
}

/** Trims model chatter and code fences down to a single `<svg>…</svg>` document. */
function extractSvgDocument(raw: string): string {
  const stripped = raw
    .replace(/^﻿/u, "")
    .replace(/<\?[\s\S]*?\?>/gu, "")
    .replace(/<!DOCTYPE[^>]*>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "")
    .trim();
  const start = stripped.indexOf("<svg");
  const end = stripped.lastIndexOf("</svg>");
  if (start < 0 || end < start) {
    throw new RlmStoryboardContractError("Storyboard output contains no <svg> document.");
  }
  return stripped.slice(start, end + "</svg>".length);
}

function assertAttributes(element: string, attributes: string): void {
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_PATTERN.exec(attributes))) {
    assertAttributeSeparator(element, attributes.slice(cursor, match.index));
    cursor = ATTRIBUTE_PATTERN.lastIndex;
    const name = match[1]!.toLowerCase();
    const value = unquote(match[2]!);
    if (name.startsWith("on")) {
      throw new RlmStoryboardContractError(
        `Storyboard SVG sets the event attribute "${name}" on <${element}>.`,
      );
    }
    if (!ALLOWED_ATTRIBUTES.has(name) && !name.startsWith("aria-")) {
      throw new RlmStoryboardContractError(
        `Storyboard SVG sets the unsupported attribute "${name}" on <${element}>.`,
      );
    }
    // `xmlns` is the one attribute whose value is legitimately an absolute URL.
    if (name === "xmlns") {
      if (value.trim() !== SVG_NAMESPACE) {
        throw new RlmStoryboardContractError(
          `Storyboard SVG declares the namespace "${value}" instead of "${SVG_NAMESPACE}".`,
        );
      }
      continue;
    }
    assertLocalReferences(`attribute "${name}"`, value);
  }
  assertAttributeSeparator(element, attributes.slice(cursor), true);
}

function assertAttributeSeparator(element: string, value: string, trailing = false): void {
  const remainder = trailing ? value.trim().replace(/\/$/u, "").trim() : value.trim();
  if (remainder.length > 0) {
    throw new RlmStoryboardContractError(
      `Storyboard SVG contains malformed attributes on <${element}>.`,
    );
  }
}

function assertRootAttributes(attributes: string): void {
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let namespace: string | undefined;
  let hasViewBox = false;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_PATTERN.exec(attributes))) {
    const name = match[1]!.toLowerCase();
    if (name === "xmlns") namespace = unquote(match[2]!).trim();
    if (name === "viewbox") hasViewBox = unquote(match[2]!).trim().length > 0;
  }
  if (namespace !== SVG_NAMESPACE) {
    throw new RlmStoryboardContractError(`Storyboard SVG must declare xmlns="${SVG_NAMESPACE}".`);
  }
  if (!hasViewBox) {
    throw new RlmStoryboardContractError("Storyboard SVG must declare a viewBox.");
  }
}

function assertStyleBlocks(document: string): void {
  const styles = document.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu);
  for (const style of styles) {
    assertLocalReferences("a <style> block", style[1] ?? "");
  }
}

function assertXmlEntities(document: string): void {
  for (const match of document.matchAll(/&([a-zA-Z][\w.-]*);/gu)) {
    const entity = match[1]!;
    if (!["amp", "apos", "gt", "lt", "quot"].includes(entity)) {
      throw new RlmStoryboardContractError(
        `Storyboard SVG uses the unsupported XML entity "&${entity};".`,
      );
    }
  }
}

/**
 * Rejects anything that would make a viewer fetch a remote resource or evaluate a URL as code.
 * Only same-document `url(#id)` references survive.
 */
function assertLocalReferences(label: string, value: string): void {
  const normalized = value.toLowerCase().replace(/\s+/gu, "");
  if (normalized.includes("@import") || normalized.includes("expression(")) {
    throw new RlmStoryboardContractError(`Storyboard SVG loads external CSS through ${label}.`);
  }
  if (/(?:javascript|vbscript|data|blob|file):/u.test(normalized)) {
    throw new RlmStoryboardContractError(
      `Storyboard SVG uses a disallowed URL scheme in ${label}.`,
    );
  }
  if (/\/\//u.test(normalized)) {
    throw new RlmStoryboardContractError(`Storyboard SVG references a remote host in ${label}.`);
  }
  for (const reference of normalized.matchAll(/url\(([^)]*)\)/gu)) {
    const target = (reference[1] ?? "").replaceAll(/["']/gu, "");
    if (!target.startsWith("#")) {
      throw new RlmStoryboardContractError(
        `Storyboard SVG references the non-local resource "${target}" in ${label}.`,
      );
    }
  }
}

function unquote(value: string): string {
  return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}
