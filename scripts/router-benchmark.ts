// Standalone diagnostic. NOT part of the test suite. Run: npm run bench:router
// Measures time-to-first-token (TTFT) and total latency for each router-model candidate
// against the local Copilot proxy, per research §8.1. Pick the router client from results.

export const ROUTER_BENCHMARK_CANDIDATES: string[] = [
  "gpt-5.4",
  "gpt-5.5",
  "claude-haiku-4.5",
  "grok-code-fast-1",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "raptor-mini",
  "gpt-5-mini",
];

const ROUTING_PROMPT =
  'Return JSON {"clientName":"CopilotProxyGpt54","model":"gpt-5.4","reasoningEffort":null,"rationale":"fast"} and nothing else.';

export async function benchmarkCandidate(
  model: string,
  env: { baseUrl: string; apiKey: string },
): Promise<{ model: string; ttftMs: number; totalMs: number; ok: boolean }> {
  const start = performance.now();
  let ttftMs = Number.NaN;
  try {
    const response = await fetch(`${env.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: ROUTING_PROMPT }],
      }),
    });

    if (!response.ok || !response.body) {
      return { model, ttftMs: Number.NaN, totalMs: performance.now() - start, ok: false };
    }

    const reader = response.body.getReader();
    let firstChunkSeen = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (!firstChunkSeen && value && value.length > 0) {
        ttftMs = performance.now() - start;
        firstChunkSeen = true;
      }
      if (done) break;
    }
    return { model, ttftMs, totalMs: performance.now() - start, ok: firstChunkSeen };
  } catch {
    return { model, ttftMs: Number.NaN, totalMs: performance.now() - start, ok: false };
  }
}

export async function main(): Promise<void> {
  const baseUrl = process.env.COPILOT_PROXY_BASE_URL;
  const apiKey = process.env.COPILOT_PROXY_API_KEY ?? "anything";
  if (!baseUrl) {
    console.error("Set COPILOT_PROXY_BASE_URL (e.g. http://127.0.0.1:8080/v1) before running.");
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const model of ROUTER_BENCHMARK_CANDIDATES) {
    rows.push(await benchmarkCandidate(model, { baseUrl, apiKey }));
  }

  console.table(
    rows.map((r) => ({
      model: r.model,
      ok: r.ok,
      ttftMs: Number.isNaN(r.ttftMs) ? "-" : Math.round(r.ttftMs),
      totalMs: Math.round(r.totalMs),
    })),
  );
}

// Run main() only when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
