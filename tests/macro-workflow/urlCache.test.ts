import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUrlCache, withUrlCache } from "../../src/macro-workflow/urlCache.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function createTempCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weavekit-url-cache-"));
  tempDirs.push(dir);
  return dir;
}

describe("url cache", () => {
  it("returns undefined on a cache miss", async () => {
    const dir = await createTempCacheDir();
    const cache = createUrlCache({ dir, ttlHours: 24 });

    await expect(cache.get("https://x.com/alice/status/1")).resolves.toBeUndefined();
  });

  it("returns a cached entry on a hit", async () => {
    const dir = await createTempCacheDir();
    const cache = createUrlCache({ dir, ttlHours: 24 });

    await cache.set("https://x.com/alice/status/1", {
      url: "https://x.com/alice/status/1",
      markdown: "# Cached content",
    });

    const entry = await cache.get("https://x.com/alice/status/1");
    expect(entry?.markdown).toBe("# Cached content");
    expect(entry?.url).toBe("https://x.com/alice/status/1");
  });

  it("treats expired entries as a miss", async () => {
    const dir = await createTempCacheDir();
    const cache = createUrlCache({ dir, ttlHours: 24 });

    await cache.set("https://x.com/alice/status/1", {
      url: "https://x.com/alice/status/1",
      markdown: "# Stale content",
    });

    // Re-open the cache with a TTL of 0 hours so the just-written entry is immediately stale.
    const expiredCache = createUrlCache({ dir, ttlHours: 0 });
    await expect(expiredCache.get("https://x.com/alice/status/1")).resolves.toBeUndefined();
  });

  it("never reads or writes when disabled", async () => {
    const dir = await createTempCacheDir();
    const cache = createUrlCache({ dir, enabled: false });

    await cache.set("https://x.com/alice/status/1", {
      url: "https://x.com/alice/status/1",
      markdown: "# Should not persist",
    });

    await expect(cache.get("https://x.com/alice/status/1")).resolves.toBeUndefined();

    const readEnabledCache = createUrlCache({ dir, enabled: true });
    await expect(readEnabledCache.get("https://x.com/alice/status/1")).resolves.toBeUndefined();
  });

  describe("withUrlCache", () => {
    it("only invokes the underlying fetcher once per URL", async () => {
      const dir = await createTempCacheDir();
      const cache = createUrlCache({ dir, ttlHours: 24 });
      const calls: string[] = [];
      const fetcher = async (url: string) => {
        calls.push(url);
        return { url, markdown: `# Content for ${url}` };
      };

      const cachedFetcher = withUrlCache(fetcher, cache);

      const first = await cachedFetcher("https://x.com/alice/status/1");
      const second = await cachedFetcher("https://x.com/alice/status/1");

      expect(first.markdown).toBe("# Content for https://x.com/alice/status/1");
      expect(second.markdown).toBe("# Content for https://x.com/alice/status/1");
      expect(calls).toEqual(["https://x.com/alice/status/1"]);
    });

    it("invokes the underlying fetcher separately for distinct URLs", async () => {
      const dir = await createTempCacheDir();
      const cache = createUrlCache({ dir, ttlHours: 24 });
      const calls: string[] = [];
      const fetcher = async (url: string) => {
        calls.push(url);
        return { url, markdown: `# Content for ${url}` };
      };

      const cachedFetcher = withUrlCache(fetcher, cache);
      await cachedFetcher("https://x.com/alice/status/1");
      await cachedFetcher("https://x.com/bob/status/2");

      expect(calls).toEqual(["https://x.com/alice/status/1", "https://x.com/bob/status/2"]);
    });
  });
});
