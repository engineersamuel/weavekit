import { describe, expect, it } from "vitest";
import { LangfusePublicApiTraceFetcher } from "../../src/mastermind/selfImprovement/langfuseClient.js";

function fakeFetch(handler: (url: string) => { ok: boolean; json: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { ok, json } = handler(url);
    return {
      ok,
      json: async () => json,
    } as Response;
  }) as typeof fetch;
}

describe("LangfusePublicApiTraceFetcher", () => {
  it("returns undefined when Langfuse export is not configured", async () => {
    const fetcher = new LangfusePublicApiTraceFetcher(
      {},
      fakeFetch(() => ({ ok: true, json: {} })),
    );
    const summary = await fetcher.fetchSubmindTraceSummary("trace-1");
    expect(summary).toBeUndefined();
  });

  it("sends basic auth and normalizes a trace with inline observations", async () => {
    const calls: string[] = [];
    const fetcher = new LangfusePublicApiTraceFetcher(
      {
        LANGFUSE_PUBLIC_KEY: "pub",
        LANGFUSE_SECRET_KEY: "sec",
        LANGFUSE_BASE_URL: "https://example.langfuse.test/",
        LANGFUSE_PROJECT_ID: "proj-1",
      },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        expect(init?.headers).toMatchObject({
          authorization: `Basic ${Buffer.from("pub:sec").toString("base64")}`,
        });
        return {
          ok: true,
          json: async () => ({
            id: "trace-1",
            input: "do the thing",
            output: "did the thing",
            observations: [
              {
                id: "obs-1",
                name: "rlm-call",
                type: "agent",
                level: "DEFAULT",
                model: "gpt-5.5",
                input: "sub-task",
                output: "sub-result",
                startTime: "2026-01-01T00:00:00.000Z",
                endTime: "2026-01-01T00:00:01.500Z",
              },
              {
                id: "obs-2",
                name: "failed-step",
                type: "tool",
                level: "ERROR",
                statusMessage: "boom",
              },
            ],
          }),
        } as Response;
      }) as typeof fetch,
    );

    const summary = await fetcher.fetchSubmindTraceSummary("trace-1");

    expect(calls[0]).toBe("https://example.langfuse.test/api/public/traces/trace-1");
    expect(summary).toMatchObject({
      traceId: "trace-1",
      url: "https://example.langfuse.test/project/proj-1/traces/trace-1",
      rootInput: "do the thing",
      rootOutput: "did the thing",
    });
    expect(summary?.observations).toHaveLength(2);
    expect(summary?.observations[0]).toMatchObject({
      name: "rlm-call",
      type: "agent",
      status: "ok",
      model: "gpt-5.5",
      durationMs: 1500,
    });
    expect(summary?.observations[1]).toMatchObject({
      name: "failed-step",
      type: "tool",
      status: "error",
    });
    expect(summary?.observations[1]?.summary).toContain("boom");
  });

  it("truncates long input/output previews", async () => {
    const longText = "x".repeat(5000);
    const fetcher = new LangfusePublicApiTraceFetcher(
      { LANGFUSE_PUBLIC_KEY: "pub", LANGFUSE_SECRET_KEY: "sec" },
      fakeFetch(() => ({
        ok: true,
        json: { id: "trace-1", input: longText, output: longText, observations: [] },
      })),
    );
    const summary = await fetcher.fetchSubmindTraceSummary("trace-1");
    expect(summary?.rootInput?.length).toBeLessThan(1300);
    expect(summary?.rootInput?.endsWith("…")).toBe(true);
  });

  it("falls back to the observations endpoint when the trace has none inline", async () => {
    const calls: string[] = [];
    const fetcher = new LangfusePublicApiTraceFetcher(
      { LANGFUSE_PUBLIC_KEY: "pub", LANGFUSE_SECRET_KEY: "sec" },
      (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        if (url.includes("/traces/")) {
          return { ok: true, json: async () => ({ id: "trace-1" }) } as Response;
        }
        return {
          ok: true,
          json: async () => ({ data: [{ id: "obs-1", name: "step", type: "tool" }] }),
        } as Response;
      }) as typeof fetch,
    );

    const summary = await fetcher.fetchSubmindTraceSummary("trace-1");

    expect(calls.some((url) => url.includes("/api/public/observations"))).toBe(true);
    expect(summary?.observations).toHaveLength(1);
    expect(summary?.observations[0]?.name).toBe("step");
  });

  it("returns undefined instead of throwing when the fetch fails", async () => {
    const fetcher = new LangfusePublicApiTraceFetcher(
      { LANGFUSE_PUBLIC_KEY: "pub", LANGFUSE_SECRET_KEY: "sec" },
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    );
    await expect(fetcher.fetchSubmindTraceSummary("trace-1")).resolves.toBeUndefined();
  });

  it("returns undefined when the trace endpoint responds with a non-ok status", async () => {
    const fetcher = new LangfusePublicApiTraceFetcher(
      { LANGFUSE_PUBLIC_KEY: "pub", LANGFUSE_SECRET_KEY: "sec" },
      fakeFetch(() => ({ ok: false, json: {} })),
    );
    const summary = await fetcher.fetchSubmindTraceSummary("trace-1");
    expect(summary).toBeUndefined();
  });

  // Langfuse v4 in events-only mode removed the whole read API, so this integration can never
  // succeed there. That used to be swallowed silently, leaving self-improvement analysis off with
  // no signal at all. Warn once per process, and still never throw.
  it("warns once when the Langfuse read API is unavailable", async () => {
    const warnings: string[] = [];
    const notFound = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;
    const env = {
      LANGFUSE_PUBLIC_KEY: "pub",
      LANGFUSE_SECRET_KEY: "sec",
      LANGFUSE_BASE_URL: "http://localhost:3000",
    };

    const first = new LangfusePublicApiTraceFetcher(env, notFound, (message) =>
      warnings.push(message),
    );
    await expect(first.fetchSubmindTraceSummary("trace-1")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("self-improvement analysis disabled");
    expect(warnings[0]).toContain("http://localhost:3000");

    // The fetcher is constructed once per execution attempt; a new instance must not repeat it.
    const second = new LangfusePublicApiTraceFetcher(env, notFound, (message) =>
      warnings.push(message),
    );
    await expect(second.fetchSubmindTraceSummary("trace-2")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
