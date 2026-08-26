import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PostImplementationReviewVerdict } from "../../src/generated/baml_client/index.js";
import {
  buildPostImplementationReviewEli5Svg,
  normalizePostImplementationReviewEli5,
  renderPostImplementationReviewEli5Markdown,
  writePostImplementationReviewEli5Artifact,
  type NormalizedPostImplementationReviewEli5,
} from "../../src/mastermind/codeReview/eli5.js";

const directories: string[] = [];
const eli5: NormalizedPostImplementationReviewEli5 = {
  hypothesis: "A code map might help an AI understand a repository.",
  purpose: "Test the tool ourselves instead of trusting product claims.",
  goal: "Build a small working demo and measure what it does.",
  outcome: "The demo worked, but it missed some caller links.",
  nextSteps: ["Get legal review.", "Test a larger repository."],
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("post-implementation ELI5", () => {
  it("normalizes model text into bounded plain-language fields", () => {
    const normalized = normalizePostImplementationReviewEli5(
      {
        hypothesis: "**We wanted** to find out whether [the tool](https://example.test) worked.",
        purpose: "<b>Test it ourselves</b>.",
        goal: "`Build` a measured demo.",
        outcome: "The demo passed.",
        nextSteps: ["First.", "Second.", "Third.", "Fourth.", "This fifth step must be dropped."],
      },
      PostImplementationReviewVerdict.PASS,
    );

    expect(normalized).toEqual({
      hypothesis: "We wanted to find out whether the tool worked.",
      purpose: "Test it ourselves.",
      goal: "Build a measured demo.",
      outcome: "The demo passed.",
      nextSteps: ["First.", "Second.", "Third.", "Fourth."],
    });
  });

  it("uses the no-work fallback only for a passing verdict", () => {
    const value = { ...eli5, nextSteps: [] };

    expect(
      normalizePostImplementationReviewEli5(value, PostImplementationReviewVerdict.PASS),
    ).toMatchObject({
      nextSteps: ["No required work remains."],
    });
    expect(
      normalizePostImplementationReviewEli5(
        value,
        PostImplementationReviewVerdict.CHANGES_REQUIRED,
      ),
    ).toBeUndefined();
    expect(
      normalizePostImplementationReviewEli5(value, PostImplementationReviewVerdict.NEEDS_HUMAN),
    ).toBeUndefined();
  });

  it("renders the complete explanation in Markdown before the optional picture", () => {
    const markdown = renderPostImplementationReviewEli5Markdown(eli5, {
      ticketTitle: "Evaluate [tool]",
      pngUrl: "https://uploads.linear.app/asset/eli5.png",
    }).join("\n");

    expect(markdown).toContain("## ELI5");
    expect(markdown).toContain("**Our guess (hypothesis):**");
    expect(markdown).toContain("**Why this mattered:**");
    expect(markdown).toContain("**What success meant:**");
    expect(markdown).toContain("**What happened:**");
    expect(markdown).toContain("**What comes next:**");
    expect(markdown).toContain("1. Get legal review.");
    expect(markdown).toContain(
      "![Plain-language summary for Evaluate tool](https://uploads.linear.app/asset/eli5.png)",
    );
  });

  it("reports visual degradation without removing the text explanation", () => {
    const markdown = renderPostImplementationReviewEli5Markdown(eli5, {
      ticketTitle: "Evaluate tool",
      visualFailed: true,
    }).join("\n");

    expect(markdown).toContain(eli5.outcome);
    expect(markdown).toContain("The infographic could not be attached.");
  });

  it.each([
    [PostImplementationReviewVerdict.PASS, "REVIEW PASSED"],
    [PostImplementationReviewVerdict.CHANGES_REQUIRED, "CHANGES NEEDED"],
    [PostImplementationReviewVerdict.NEEDS_HUMAN, "HUMAN DECISION"],
  ])("renders an accessible %s infographic", (verdict, label) => {
    const svg = buildPostImplementationReviewEli5Svg({
      ticketTitle: "Evaluate <tool>",
      verdict,
      eli5: {
        ...eli5,
        hypothesis: "<script>alert('no')</script> The map might help.",
      },
    });

    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="eli5-title eli5-description"');
    expect(svg).toContain("OUR GUESS");
    expect(svg).toContain("WHY IT MATTERED");
    expect(svg).toContain("WHAT SUCCESS MEANT");
    expect(svg).toContain("WHAT HAPPENED");
    expect(svg).toContain("WHAT COMES NEXT");
    expect(svg).toContain(label);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain('<title id="eli5-title">Evaluate: plain-language review summary</title>');
  });

  it("writes stable review-owned SVG and PNG artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mastermind-eli5-"));
    directories.push(directory);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const artifact = await writePostImplementationReviewEli5Artifact(
      {
        worktreePath: directory,
        reviewId: "review-123",
        ticketTitle: "Evaluate tool",
        verdict: PostImplementationReviewVerdict.PASS,
        eli5,
      },
      async () => png,
    );

    expect(artifact).toMatchObject({
      svgPath: ".weavekit/mastermind-code-review/review-123/eli5.svg",
      pngPath: ".weavekit/mastermind-code-review/review-123/eli5.png",
    });
    await expect(readFile(join(directory, artifact.svgPath), "utf8")).resolves.toContain(
      "THE BIG PICTURE",
    );
    await expect(readFile(join(directory, artifact.pngPath))).resolves.toEqual(Buffer.from(png));
  });

  it("rejects review ids that could escape the artifact directory", async () => {
    await expect(
      writePostImplementationReviewEli5Artifact(
        {
          worktreePath: "/tmp",
          reviewId: "../outside",
          ticketTitle: "Evaluate tool",
          verdict: PostImplementationReviewVerdict.PASS,
          eli5,
        },
        async () => new Uint8Array(),
      ),
    ).rejects.toThrow("not safe for an artifact path");
  });
});
