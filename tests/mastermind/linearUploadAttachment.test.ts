import { describe, expect, it } from "vitest";
import { LinearGraphQlGateway } from "../../src/mastermind/linear/client.js";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  query?: string;
  variables?: Record<string, unknown>;
  body?: unknown;
};

/**
 * Stands in for the whole upload boundary: the two GraphQL mutations and the signed PUT that
 * happens between them, so the test never touches a network.
 */
function fakeFetch(
  calls: Call[],
  overrides: { uploadOk?: boolean; uploadSuccess?: boolean; attachSuccess?: boolean } = {},
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "POST";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (method === "PUT") {
      calls.push({ url: String(url), method, headers, body: init?.body });
      return { ok: overrides.uploadOk ?? true, status: 500 } as Response;
    }
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ url: String(url), method, headers, query: body.query, variables: body.variables });
    if (body.query.includes("MastermindFileUpload")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            fileUpload: {
              success: overrides.uploadSuccess ?? true,
              uploadFile: {
                uploadUrl: "https://uploads.linear.app/signed",
                assetUrl: "https://uploads.linear.app/asset/storyboard.png",
                headers: [{ key: "x-linear-signature", value: "signed" }],
              },
            },
          },
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        data: { attachmentCreate: { success: overrides.attachSuccess ?? true } },
      }),
    } as Response;
  }) as typeof fetch;
}

function gateway(fetcher: typeof fetch): LinearGraphQlGateway {
  return new LinearGraphQlGateway("test-api-key", "https://api.linear.app/graphql", fetcher);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function upload(): Parameters<LinearGraphQlGateway["uploadIssueAttachment"]>[0] {
  return {
    issueId: "issue-1",
    fileName: "submind-storyboard-attempt-1.png",
    contentType: "image/png",
    title: "Submind storyboard (attempt 1)",
    data: PNG,
  };
}

describe("LinearGraphQlGateway.uploadIssueAttachment", () => {
  it("requests an upload slot, PUTs the bytes with the signed headers, then attaches the asset", async () => {
    const calls: Call[] = [];

    const result = await gateway(fakeFetch(calls)).uploadIssueAttachment(upload());

    expect(result).toEqual({ assetUrl: "https://uploads.linear.app/asset/storyboard.png" });
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
    expect(calls[0]?.variables).toMatchObject({
      contentType: "image/png",
      filename: "submind-storyboard-attempt-1.png",
      size: PNG.byteLength,
    });
    // The signature is computed over the returned headers, so they must be sent back unchanged,
    // alongside Linear's documented content-type and cache-control headers.
    expect(calls[1]).toMatchObject({
      url: "https://uploads.linear.app/signed",
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000",
        "x-linear-signature": "signed",
      },
      body: PNG,
    });
    expect(calls[2]?.query).toContain("attachmentCreate");
    expect(calls[2]?.variables).toMatchObject({
      issueId: "issue-1",
      title: "Submind storyboard (attempt 1)",
      url: "https://uploads.linear.app/asset/storyboard.png",
    });
  });

  it("throws before uploading anything when Linear refuses the upload slot", async () => {
    const calls: Call[] = [];

    await expect(
      gateway(fakeFetch(calls, { uploadSuccess: false })).uploadIssueAttachment(upload()),
    ).rejects.toThrow("rejected the upload request");
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("throws with the HTTP status when the signed PUT fails", async () => {
    const calls: Call[] = [];

    await expect(
      gateway(fakeFetch(calls, { uploadOk: false })).uploadIssueAttachment(upload()),
    ).rejects.toThrow("failed with HTTP 500");
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT"]);
  });

  it("throws when Linear stores the bytes but refuses the attachment", async () => {
    const calls: Call[] = [];

    await expect(
      gateway(fakeFetch(calls, { attachSuccess: false })).uploadIssueAttachment(upload()),
    ).rejects.toThrow("rejected the attachment");
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
  });
});
