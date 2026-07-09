import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGrokXPostFetcher,
  extractXPostUrls,
  preprocessWorkflowPrompt,
} from "../../src/macro-workflow/promptPreprocessor.js";
import { createUrlCache } from "../../src/macro-workflow/urlCache.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function createTempCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weavekit-prompt-preprocessor-cache-"));
  tempDirs.push(dir);
  return dir;
}

describe("X post prompt preprocessing", () => {
  it("detects unique X and Twitter status URLs in encounter order", () => {
    expect(
      extractXPostUrls(
        [
          "Read https://x.com/alice/status/12345, then compare",
          "Duplicate https://x.com/alice/status/12345.",
          "Legacy https://twitter.com/bob/status/67890?s=20",
          "Ignore https://x.com/explore and https://twitter.com/bob",
        ].join("\n"),
      ),
    ).toEqual(["https://x.com/alice/status/12345", "https://twitter.com/bob/status/67890?s=20"]);
  });

  it("returns the original prompt without invoking the fetcher when no status URL is present", async () => {
    const calls: string[] = [];

    const result = await preprocessWorkflowPrompt({
      prompt: "Read this local source.",
      fetchXPost: async (url) => {
        calls.push(url);
        return { url, markdown: "# Should not run" };
      },
    });

    expect(result).toEqual({ prompt: "Read this local source.", fetchedXPosts: [] });
    expect(calls).toEqual([]);
  });

  it("serves a warm cache entry without invoking the default grok fetcher", async () => {
    const dir = await createTempCacheDir();
    const cache = createUrlCache({ dir, ttlHours: 24 });
    await cache.set("https://x.com/alice/status/12345", {
      url: "https://x.com/alice/status/12345",
      markdown: "# Cached Alice Post\n\nAlready fetched.",
    });

    const result = await preprocessWorkflowPrompt({
      prompt: "Apply https://x.com/alice/status/12345.",
      cache: { dir, ttlHours: 24 },
    });

    expect(result.fetchedXPosts).toEqual([
      {
        url: "https://x.com/alice/status/12345",
        markdown: "# Cached Alice Post\n\nAlready fetched.",
      },
    ]);
    expect(result.prompt).toContain("# Cached Alice Post");
  });

  it("fetches each unique status URL once and appends markdown sections to the prompt", async () => {
    const calls: string[] = [];

    const result = await preprocessWorkflowPrompt({
      prompt: "Apply https://x.com/alice/status/12345 and https://x.com/alice/status/12345.",
      fetchXPost: async (url) => {
        calls.push(url);
        return { url, markdown: "# Alice Post\n\nFetched body." };
      },
    });

    expect(calls).toEqual(["https://x.com/alice/status/12345"]);
    expect(result.fetchedXPosts).toEqual([
      { url: "https://x.com/alice/status/12345", markdown: "# Alice Post\n\nFetched body." },
    ]);
    expect(result.prompt).toBe(
      [
        "Apply https://x.com/alice/status/12345 and https://x.com/alice/status/12345.",
        "",
        "## Resolved X Post Sources",
        "",
        "### https://x.com/alice/status/12345",
        "",
        "# Alice Post\n\nFetched body.",
      ].join("\n"),
    );
  });

  it("includes explicit source URLs when preprocessing the workflow prompt", async () => {
    const calls: string[] = [];

    await preprocessWorkflowPrompt({
      prompt: "Apply this source to weavekit.",
      source: "https://x.com/alice/status/12345",
      fetchXPost: async (url) => {
        calls.push(url);
        return { url, markdown: "# Alice Post" };
      },
    });

    expect(calls).toEqual(["https://x.com/alice/status/12345"]);
  });

  it("runs grok with the x_search fetch prompt and returns trimmed markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-fetcher-"));
    tempDirs.push(root);
    const argsPath = join(root, "args.txt");
    const grokPath = join(root, "grok");
    await writeFile(
      grokPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        "printf '\\n# Clean Markdown\\n\\nBody.\\n'",
      ].join("\n"),
      "utf8",
    );
    await chmod(grokPath, 0o755);

    const fetchXPost = createGrokXPostFetcher({ command: grokPath, timeoutMs: 1_000 });
    const result = await fetchXPost("https://x.com/alice/status/12345");

    expect(result).toEqual({
      url: "https://x.com/alice/status/12345",
      markdown: "# Clean Markdown\n\nBody.",
    });
    await expect(readText(argsPath)).resolves.toContain(
      "x_search tool to fetch the full content of https://x.com/alice/status/12345",
    );
    await expect(readText(argsPath)).resolves.toContain("grok-4.5");
    await expect(readText(argsPath)).resolves.toContain("plain");
  });

  it("throws clear errors for command failure, missing grok, empty output, and timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-failures-"));
    tempDirs.push(root);
    const failing = join(root, "grok-failing");
    const empty = join(root, "grok-empty");
    const slow = join(root, "grok-slow");
    await writeFile(failing, "#!/bin/sh\necho nope >&2\nexit 7\n", "utf8");
    await writeFile(empty, "#!/bin/sh\nprintf '   \\n'\n", "utf8");
    await writeFile(slow, "#!/bin/sh\nsleep 2\nprintf '# late'\n", "utf8");
    await chmod(failing, 0o755);
    await chmod(empty, 0o755);
    await chmod(slow, 0o755);

    await expect(
      createGrokXPostFetcher({ command: failing, timeoutMs: 1_000 })("https://x.com/a/status/1"),
    ).rejects.toThrow("grok failed");
    await expect(
      createGrokXPostFetcher({ command: "definitely-missing-grok-binary", timeoutMs: 1_000 })(
        "https://x.com/a/status/1",
      ),
    ).rejects.toThrow("Could not find grok");
    await expect(
      createGrokXPostFetcher({ command: empty, timeoutMs: 1_000 })("https://x.com/a/status/1"),
    ).rejects.toThrow("empty content");
    await expect(
      createGrokXPostFetcher({ command: slow, timeoutMs: 10 })("https://x.com/a/status/1"),
    ).rejects.toThrow("timed out");
  });
});

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
