import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCacheConfig, type CacheConfig } from "../config.js";

export type UrlCacheEntry = {
  url: string;
  markdown: string;
  fetchedAt: string;
};

export type UrlCacheOptions = Partial<CacheConfig>;

export type UrlCache = {
  get(url: string): Promise<UrlCacheEntry | undefined>;
  set(url: string, entry: Omit<UrlCacheEntry, "fetchedAt">): Promise<void>;
};

/**
 * File-backed cache for URL content (e.g. Grok X-post fetches). Entries live under
 * `<dir>/<sha256(url)>.json` so they're globally shared across workflow runs and easy to
 * inspect/clear by hand. Disabled entirely when `enabled` is false (e.g. `--no-cache`).
 */
export function createUrlCache(options: UrlCacheOptions = {}): UrlCache {
  const defaults = defaultCacheConfig();
  const enabled = options.enabled ?? defaults.enabled;
  const ttlHours = options.ttlHours ?? defaults.ttlHours;
  const dir = options.dir ?? defaults.dir;

  return {
    async get(url: string): Promise<UrlCacheEntry | undefined> {
      if (!enabled) {
        return undefined;
      }
      const filePath = cacheFilePath(dir, url);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        return undefined;
      }

      let entry: UrlCacheEntry;
      try {
        entry = JSON.parse(raw) as UrlCacheEntry;
      } catch {
        return undefined;
      }

      if (isExpired(entry.fetchedAt, ttlHours)) {
        return undefined;
      }
      return entry;
    },

    async set(url: string, entry: Omit<UrlCacheEntry, "fetchedAt">): Promise<void> {
      if (!enabled) {
        return;
      }
      const filePath = cacheFilePath(dir, url);
      const record: UrlCacheEntry = { ...entry, fetchedAt: new Date().toISOString() };
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    },
  };
}

/**
 * Wraps a URL fetcher so repeated calls for the same URL are served from `cache` instead of
 * re-invoking the (typically slow/expensive) underlying fetcher.
 */
export function withUrlCache<T extends { url: string; markdown: string }>(
  fetcher: (url: string) => Promise<T>,
  cache: UrlCache,
): (url: string) => Promise<T> {
  return async (url: string): Promise<T> => {
    const cached = await cache.get(url);
    if (cached) {
      return { url: cached.url, markdown: cached.markdown } as T;
    }

    const result = await fetcher(url);
    await cache.set(url, { url: result.url, markdown: result.markdown });
    return result;
  };
}

function cacheFilePath(dir: string, url: string): string {
  const hash = createHash("sha256").update(url).digest("hex");
  return join(dir, `${hash}.json`);
}

function isExpired(fetchedAt: string, ttlHours: number): boolean {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (Number.isNaN(fetchedAtMs)) {
    return true;
  }
  const ttlMs = ttlHours * 60 * 60 * 1000;
  return ttlMs <= 0 || Date.now() - fetchedAtMs >= ttlMs;
}
