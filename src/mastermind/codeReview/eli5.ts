import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { PostImplementationReviewVerdict } from "../../generated/baml_client/index.js";
import type { RlmStoryboardRasterizer } from "../../rlm-poc/visualization/contracts.js";
import { resvgStoryboardRasterizer } from "../../rlm-poc/visualization/rasterizer.js";
import { sanitizeStoryboardSvg } from "../../rlm-poc/visualization/svg.js";

const ARTIFACT_ROOT = ".weavekit/mastermind-code-review";
const MAX_FIELD_LENGTH = 280;
const MAX_NEXT_STEP_LENGTH = 200;
const MAX_NEXT_STEPS = 4;

export type NormalizedPostImplementationReviewEli5 = {
  hypothesis: string;
  purpose: string;
  goal: string;
  outcome: string;
  nextSteps: string[];
};

export type PostImplementationReviewEli5Artifact = {
  svgPath: string;
  pngPath: string;
  png: Uint8Array;
};

export function normalizePostImplementationReviewEli5(
  value: unknown,
  verdict: PostImplementationReviewVerdict,
): NormalizedPostImplementationReviewEli5 | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const hypothesis = plainText(record.hypothesis, MAX_FIELD_LENGTH);
  const purpose = plainText(record.purpose, MAX_FIELD_LENGTH);
  const goal = plainText(record.goal, MAX_FIELD_LENGTH);
  const outcome = plainText(record.outcome, MAX_FIELD_LENGTH);
  if (!hypothesis || !purpose || !goal || !outcome) return undefined;
  const nextSteps = Array.isArray(record.nextSteps)
    ? record.nextSteps
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => plainText(entry, MAX_NEXT_STEP_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_NEXT_STEPS)
    : [];
  if (nextSteps.length === 0 && verdict !== PostImplementationReviewVerdict.PASS) return undefined;
  return {
    hypothesis,
    purpose,
    goal,
    outcome,
    nextSteps: nextSteps.length > 0 ? nextSteps : ["No required work remains."],
  };
}

export function renderPostImplementationReviewEli5Markdown(
  eli5: NormalizedPostImplementationReviewEli5,
  input: {
    ticketTitle: string;
    pngUrl?: string;
    visualFailed?: boolean;
  },
): string[] {
  return [
    "## ELI5",
    "",
    `**Our guess (hypothesis):** ${eli5.hypothesis}`,
    "",
    `**Why this mattered:** ${eli5.purpose}`,
    "",
    `**What success meant:** ${eli5.goal}`,
    "",
    `**What happened:** ${eli5.outcome}`,
    "",
    "**What comes next:**",
    ...eli5.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    ...(input.pngUrl
      ? ["", `![Plain-language summary for ${markdownAltText(input.ticketTitle)}](${input.pngUrl})`]
      : input.visualFailed
        ? [
            "",
            "> The infographic could not be attached. The plain-language summary above is complete.",
          ]
        : []),
  ];
}

export function buildPostImplementationReviewEli5Svg(input: {
  ticketTitle: string;
  verdict: PostImplementationReviewVerdict;
  eli5: NormalizedPostImplementationReviewEli5;
}): string {
  const { label: verdictLabel, color: verdictColor } = verdictStyle(input.verdict);
  const topCards = [
    card({
      x: 48,
      y: 205,
      width: 419,
      height: 250,
      number: "1",
      label: "OUR GUESS",
      text: input.eli5.hypothesis,
      accent: "#8F2D23",
    }),
    card({
      x: 491,
      y: 205,
      width: 419,
      height: 250,
      number: "2",
      label: "WHY IT MATTERED",
      text: input.eli5.purpose,
      accent: "#1E4E8C",
    }),
    card({
      x: 934,
      y: 205,
      width: 418,
      height: 250,
      number: "3",
      label: "WHAT SUCCESS MEANT",
      text: input.eli5.goal,
      accent: "#76520E",
    }),
  ];
  const outcomeLines = textLines(input.eli5.outcome, 44, 6);
  const nextSteps = input.eli5.nextSteps.flatMap((step, index) =>
    numberedStep(step, index + 1, 756, 584 + index * 60),
  );
  const title = plainText(input.ticketTitle, 110) || "Mastermind review";
  const titleLines = textLines(title, 30, 2);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 860" width="1400" height="860" role="img" aria-labelledby="eli5-title eli5-description">',
    `<title id="eli5-title">${xml(title)}: plain-language review summary</title>`,
    `<desc id="eli5-description">Five-part explanation of the hypothesis, purpose, goal, outcome, and next steps.</desc>`,
    '<rect x="0" y="0" width="1400" height="860" fill="#F5F0E4"/>',
    '<path d="M0 0H1400V18H0Z" fill="#17221C"/>',
    '<path d="M48 190C260 170 450 194 678 180C906 166 1116 194 1352 174" fill="none" stroke="#D2C6AD" stroke-width="3" stroke-dasharray="7 10"/>',
    '<text x="48" y="62" fill="#8F2D23" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="17" font-weight="700" letter-spacing="2">THE BIG PICTURE</text>',
    ...titleLines.map(
      (line, index) =>
        `<text x="48" y="${104 + index * 40}" fill="#17221C" font-family="Georgia, serif" font-size="36" font-weight="700">${xml(line)}</text>`,
    ),
    '<text x="48" y="178" fill="#4C5A52" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="18">A plain-language map of the reviewed result</text>',
    `<rect x="1110" y="58" width="242" height="58" rx="29" fill="${verdictColor}"/>`,
    `<text x="1231" y="94" text-anchor="middle" fill="#FFFDF7" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="18" font-weight="700">${xml(verdictLabel)}</text>`,
    ...topCards,
    '<rect x="48" y="474" width="640" height="326" rx="26" fill="#18342D"/>',
    '<circle cx="92" cy="522" r="22" fill="#F5F0E4"/>',
    '<text x="92" y="529" text-anchor="middle" fill="#18342D" font-family="Georgia, serif" font-size="20" font-weight="700">4</text>',
    '<text x="126" y="529" fill="#CDE7D9" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="16" font-weight="700" letter-spacing="1.5">WHAT HAPPENED</text>',
    ...outcomeLines.map(
      (line, index) =>
        `<text x="80" y="${588 + index * 38}" fill="#FFFDF7" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="27" font-weight="500">${xml(line)}</text>`,
    ),
    '<rect x="712" y="474" width="640" height="326" rx="26" fill="#FFE6A7"/>',
    '<circle cx="756" cy="522" r="22" fill="#76520E"/>',
    '<text x="756" y="529" text-anchor="middle" fill="#FFFDF7" font-family="Georgia, serif" font-size="20" font-weight="700">5</text>',
    '<text x="790" y="529" fill="#5F410A" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="16" font-weight="700" letter-spacing="1.5">WHAT COMES NEXT</text>',
    ...nextSteps,
    '<text x="48" y="832" fill="#647168" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="15">The detailed evidence remains in the technical review below this picture.</text>',
    "</svg>",
  ].join("");
  return sanitizeStoryboardSvg(svg);
}

export async function writePostImplementationReviewEli5Artifact(
  input: {
    worktreePath: string;
    reviewId: string;
    ticketTitle: string;
    verdict: PostImplementationReviewVerdict;
    eli5: NormalizedPostImplementationReviewEli5;
  },
  rasterizer: RlmStoryboardRasterizer = resvgStoryboardRasterizer,
): Promise<PostImplementationReviewEli5Artifact> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(input.reviewId)) {
    throw new Error(`Code review id is not safe for an artifact path: ${input.reviewId}`);
  }
  const relativeDirectory = posix.join(ARTIFACT_ROOT, input.reviewId);
  const svgPath = posix.join(relativeDirectory, "eli5.svg");
  const pngPath = posix.join(relativeDirectory, "eli5.png");
  const absoluteDirectory = join(input.worktreePath, ARTIFACT_ROOT, input.reviewId);
  const svg = buildPostImplementationReviewEli5Svg(input);
  const png = await rasterizer(svg);
  await mkdir(absoluteDirectory, { recursive: true });
  await Promise.all([
    writeAtomic(join(input.worktreePath, svgPath), `${svg}\n`),
    writeAtomic(join(input.worktreePath, pngPath), png),
  ]);
  return { svgPath, pngPath, png };
}

function card(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  number: string;
  label: string;
  text: string;
  accent: string;
}): string {
  const lines = textLines(input.text, 28, 4);
  return [
    `<rect x="${input.x}" y="${input.y}" width="${input.width}" height="${input.height}" rx="22" fill="#FFFDF7" stroke="#D2C6AD" stroke-width="2"/>`,
    `<rect x="${input.x}" y="${input.y}" width="10" height="${input.height}" rx="5" fill="${input.accent}"/>`,
    `<circle cx="${input.x + 48}" cy="${input.y + 48}" r="22" fill="${input.accent}"/>`,
    `<text x="${input.x + 48}" y="${input.y + 55}" text-anchor="middle" fill="#FFFDF7" font-family="Georgia, serif" font-size="20" font-weight="700">${input.number}</text>`,
    `<text x="${input.x + 82}" y="${input.y + 54}" fill="${input.accent}" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="15" font-weight="700" letter-spacing="1.3">${input.label}</text>`,
    ...lines.map(
      (line, index) =>
        `<text x="${input.x + 32}" y="${input.y + 111 + index * 35}" fill="#17221C" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="25" font-weight="500">${xml(line)}</text>`,
    ),
  ].join("");
}

function numberedStep(text: string, number: number, x: number, y: number): string[] {
  const lines = textLines(text, 45, 2);
  return [
    `<circle cx="${x + 14}" cy="${y - 6}" r="14" fill="#76520E"/>`,
    `<text x="${x + 14}" y="${y}" text-anchor="middle" fill="#FFFDF7" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="13" font-weight="700">${number}</text>`,
    ...lines.map(
      (line, index) =>
        `<text x="${x + 42}" y="${y + index * 26}" fill="#17221C" font-family="Avenir Next, Trebuchet MS, sans-serif" font-size="21" font-weight="600">${xml(line)}</text>`,
    ),
  ];
}

function textLines(value: string, maxCharacters: number, maxLines: number): string[] {
  const words = value.split(" ").flatMap((word) => splitLongWord(word, maxCharacters));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  const consumed = lines.join(" ").length;
  if (consumed < value.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines.at(-1)!.replace(/[.,;:!?]?$/u, "")}...`;
  }
  return lines;
}

function splitLongWord(word: string, maxCharacters: number): string[] {
  if (word.length <= maxCharacters) return [word];
  const pieces: string[] = [];
  for (let index = 0; index < word.length; index += maxCharacters) {
    pieces.push(word.slice(index, index + maxCharacters));
  }
  return pieces;
}

function plainText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const plain = value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[`*_~#>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,;:!?])/gu, "$1")
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 3).trimEnd()}...` : plain;
}

function markdownAltText(value: string): string {
  return plainText(value, 100).replaceAll("[", "").replaceAll("]", "");
}

function verdictStyle(verdict: PostImplementationReviewVerdict): {
  label: string;
  color: string;
} {
  switch (verdict) {
    case PostImplementationReviewVerdict.PASS:
      return { label: "REVIEW PASSED", color: "#0B6B4F" };
    case PostImplementationReviewVerdict.CHANGES_REQUIRED:
      return { label: "CHANGES NEEDED", color: "#9A4A08" };
    case PostImplementationReviewVerdict.NEEDS_HUMAN:
      return { label: "HUMAN DECISION", color: "#1E4E8C" };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
