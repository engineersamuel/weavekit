import { describe, expect, it } from "vitest";
import { LinearGraphQlGateway } from "../../src/mastermind/linear/client.js";

const ISSUE = {
  id: "issue-1",
  identifier: "ENG-20",
  url: "https://linear.app/eng/issue/ENG-20",
  title: "Evaluate the harness",
  description: "Compare the options.",
  updatedAt: "2026-08-25T00:00:00.000Z",
  state: { name: "Todo" },
  team: { id: "team-1" },
  project: { id: "project-1" },
  labels: { nodes: [] },
};

type AssetResponse = {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: string;
  throws?: Error;
};

/**
 * A fetcher that answers the GraphQL endpoint with one issue plus the given attachment nodes, and
 * answers every other URL from `assets`.
 */
function fakeFetch(
  attachmentNodes: unknown[],
  assets: Record<string, AssetResponse> = {},
): { fetcher: typeof fetch; assetHeaders: Record<string, string | undefined> } {
  const assetHeaders: Record<string, string | undefined> = {};
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === "https://api.linear.app/graphql") {
      return {
        ok: true,
        json: async () => ({
          data: { issue: { ...ISSUE, attachments: { nodes: attachmentNodes } } },
        }),
      } as Response;
    }
    assetHeaders[target] = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const asset = assets[target];
    if (asset?.throws) {
      throw asset.throws;
    }
    return {
      ok: asset?.ok ?? true,
      status: asset?.status ?? 200,
      headers: { get: () => asset?.contentType ?? "text/markdown" },
      text: async () => asset?.body ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  return { fetcher, assetHeaders };
}

function gatewayFor(fetcher: typeof fetch): LinearGraphQlGateway {
  return new LinearGraphQlGateway("test-api-key", "https://api.linear.app/graphql", fetcher);
}

describe("Linear attachment resolution", () => {
  it("fetches a Linear-hosted attachment body with the API key", async () => {
    const url = "https://uploads.linear.app/observation.md";
    const { fetcher, assetHeaders } = fakeFetch(
      [{ title: "Private observation", url, subtitle: "Field notes" }],
      { [url]: { body: "Prefer the native harness." } },
    );

    const ticket = await gatewayFor(fetcher).fetchIssue("issue-1");

    expect(ticket.attachments).toEqual([
      {
        title: "Private observation",
        url,
        subtitle: "Field notes",
        body: "Prefer the native harness.",
      },
    ]);
    expect(assetHeaders[url]).toBe("test-api-key");
  });

  it("truncates a body over the size cap and marks it", async () => {
    const url = "https://uploads.linear.app/large.md";
    const { fetcher } = fakeFetch([{ title: "Large", url }], {
      [url]: { body: "x".repeat(80_000) },
    });

    const ticket = await gatewayFor(fetcher).fetchIssue("issue-1");

    expect(ticket.attachments?.[0]).toMatchObject({ truncated: true });
    expect(ticket.attachments?.[0]?.body).toHaveLength(32_000);
  });

  it("degrades a failed fetch to a title-only entry instead of failing the review", async () => {
    const url = "https://uploads.linear.app/broken.md";
    const { fetcher } = fakeFetch([{ title: "Broken", url }], {
      [url]: { throws: new Error("socket hang up") },
    });

    const ticket = await gatewayFor(fetcher).fetchIssue("issue-1");

    expect(ticket.attachments).toEqual([
      { title: "Broken", url, unavailableReason: "Attachment fetch failed: socket hang up" },
    ]);
  });

  it("degrades a non-OK response to a title-only entry", async () => {
    const url = "https://uploads.linear.app/forbidden.md";
    const { fetcher } = fakeFetch([{ title: "Forbidden", url }], {
      [url]: { ok: false, status: 403 },
    });

    const ticket = await gatewayFor(fetcher).fetchIssue("issue-1");

    expect(ticket.attachments?.[0]?.unavailableReason).toContain("HTTP 403");
    expect(ticket.attachments?.[0]?.body).toBeUndefined();
  });

  it("skips a non-text body", async () => {
    const url = "https://uploads.linear.app/diagram.png";
    const { fetcher } = fakeFetch([{ title: "Diagram", url }], {
      [url]: { contentType: "image/png" },
    });

    const ticket = await gatewayFor(fetcher).fetchIssue("issue-1");

    expect(ticket.attachments?.[0]?.unavailableReason).toContain("image/png");
  });

  it("never sends the API key to a host other than Linear", async () => {
    const url = "https://example.com/notes.md";
    const { fetcher, assetHeaders } = fakeFetch([{ title: "External", url }]);

    const ticket = await gatewayFor(fetcher).fetchIssue("issue-1");

    expect(ticket.attachments?.[0]?.unavailableReason).toBe(
      "Not a Linear-hosted asset; body not fetched.",
    );
    expect(assetHeaders[url]).toBeUndefined();
  });

  it("omits the field entirely when the issue has no attachments", async () => {
    const { fetcher } = fakeFetch([]);

    expect(await gatewayFor(fetcher).fetchIssue("issue-1")).not.toHaveProperty("attachments");
  });
});
