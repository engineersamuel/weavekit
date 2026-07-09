import { spawn as nodeSpawn } from "node:child_process";

const DEFAULT_GROK_TIMEOUT_MS = 300_000;
const X_POST_HOSTS = new Set(["x.com", "twitter.com"]);

export type XPostFetchResult = {
  url: string;
  markdown: string;
};

export type XPostFetcher = (url: string) => Promise<XPostFetchResult>;

type GrokXPostFetcherOptions = {
  command?: string;
  timeoutMs?: number;
  spawnFn?: typeof nodeSpawn;
};

export function extractXPostUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const urlMatches = text.matchAll(/https?:\/\/[^\s<>"']+/gi);

  for (const match of urlMatches) {
    const candidate = stripTrailingUrlPunctuation(match[0] ?? "");
    if (!candidate || seen.has(candidate) || !isXStatusUrl(candidate)) {
      continue;
    }
    seen.add(candidate);
    urls.push(candidate);
  }

  return urls;
}

export async function preprocessWorkflowPrompt(args: {
  prompt: string;
  source?: string;
  fetchXPost?: XPostFetcher;
}): Promise<{ prompt: string; fetchedXPosts: XPostFetchResult[] }> {
  const urls = extractXPostUrls([args.prompt, args.source].filter((part): part is string => Boolean(part)).join("\n"));
  if (urls.length === 0) {
    return { prompt: args.prompt, fetchedXPosts: [] };
  }

  const fetchXPost = args.fetchXPost ?? createGrokXPostFetcher();
  const fetchedXPosts: XPostFetchResult[] = [];
  for (const url of urls) {
    const fetched = await fetchXPost(url);
    const markdown = fetched.markdown.trim();
    if (!markdown) {
      throw new Error(`grok returned empty content for ${url}.`);
    }
    fetchedXPosts.push({ url: fetched.url || url, markdown });
  }

  return {
    prompt: appendFetchedXPosts(args.prompt, fetchedXPosts),
    fetchedXPosts,
  };
}

export function createGrokXPostFetcher(args: GrokXPostFetcherOptions = {}): XPostFetcher {
  const command = args.command ?? "grok";
  const timeoutMs = args.timeoutMs ?? DEFAULT_GROK_TIMEOUT_MS;
  const spawnFn = args.spawnFn ?? nodeSpawn;

  return async (url) => new Promise<XPostFetchResult>((resolve, reject) => {
    const prompt = `Use the x_search tool to fetch the full content of ${url} and output the complete article as clean markdown.`;
    const child = spawnFn(command, [
      "-p",
      prompt,
      "-m",
      "grok-4.5",
      "--output-format",
      "plain",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      settle(() => {
        child.kill("SIGTERM");
        reject(new Error(`grok timed out after ${timeoutMs}ms while fetching ${url}.`));
      });
    }, timeoutMs);

    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      finish();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() => {
        if (error.code === "ENOENT") {
          reject(new Error(`Could not find grok on PATH while fetching ${url}. Install grok or make it available on PATH.`));
          return;
        }
        reject(new Error(`grok failed to start while fetching ${url}: ${error.message}`));
      });
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (code !== 0) {
          const details = stderr.trim() || (signal ? `terminated by signal ${signal}` : "no stderr output");
          reject(new Error(`grok failed while fetching ${url} with exit code ${code ?? "unknown"}: ${details}`));
          return;
        }

        const markdown = stdout.trim();
        if (!markdown) {
          reject(new Error(`grok returned empty content for ${url}.`));
          return;
        }
        resolve({ url, markdown });
      });
    });
  });
}

function appendFetchedXPosts(prompt: string, fetchedXPosts: XPostFetchResult[]): string {
  const sections = fetchedXPosts.flatMap((post) => [
    `### ${post.url}`,
    "",
    post.markdown,
  ]);
  const resolvedSection = [
    "## Resolved X Post Sources",
    "",
    ...sections,
  ].join("\n");
  const basePrompt = prompt.trimEnd();
  return basePrompt ? `${basePrompt}\n\n${resolvedSection}` : resolvedSection;
}

function stripTrailingUrlPunctuation(rawUrl: string): string {
  let url = rawUrl;
  while (url.length > 0) {
    const stripped = url
      .replace(/[.,;:!?]+$/u, "")
      .replace(/[\])}]+$/u, "");
    if (stripped === url) {
      return url;
    }
    url = stripped;
  }
  return url;
}

function isXStatusUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    if (!X_POST_HOSTS.has(host)) {
      return false;
    }
    return /\/[^/]+\/status\/\d+(?:\/|$)/u.test(url.pathname);
  } catch {
    return false;
  }
}
