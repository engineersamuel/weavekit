import { describe, expect, it } from "vitest";
import {
  extractQuickTunnelUrl,
  formatElapsed,
  LinearSetupClient,
  resolveLiveWebhookConfiguration,
} from "../../src/mastermind/live.js";
import { loadTypedWeavekitConfig } from "../../src/config.js";

describe("Mastermind live setup", () => {
  it("extracts the Cloudflare Quick Tunnel URL from mixed logs", () => {
    expect(
      extractQuickTunnelUrl(
        "INF Requesting new quick Tunnel\nhttps://lucky-forest-325c.trycloudflare.com\n",
      ),
    ).toBe("https://lucky-forest-325c.trycloudflare.com");
    expect(extractQuickTunnelUrl("no tunnel yet")).toBeUndefined();
    expect(formatElapsed(15_999)).toBe("00:15");
    expect(formatElapsed(125_000)).toBe("02:05");
  });

  it("uses a complete persistent webhook configuration without prompting", () => {
    const defaults = loadTypedWeavekitConfig("/path/that/does/not/exist", {}).mastermind;

    expect(
      resolveLiveWebhookConfiguration(
        {
          ...defaults,
          publicWebhookUrl: "https://mastermind.example.com/channels/linear/webhook",
          linearWebhookId: "webhook-one",
          cloudflareTunnel: "weavekit-mastermind",
          cloudflareTunnelConfig: "/tmp/cloudflared.yml",
        },
        { LINEAR_WEBHOOK_SECRET: "secret-one" },
      ),
    ).toEqual({
      mode: "persistent",
      webhookId: "webhook-one",
      webhookUrl: "https://mastermind.example.com/channels/linear/webhook",
      webhookSecret: "secret-one",
      cloudflareTunnel: "weavekit-mastermind",
      cloudflareTunnelConfig: "/tmp/cloudflared.yml",
    });
  });

  it("fails closed on partial persistent webhook configuration", () => {
    const defaults = loadTypedWeavekitConfig("/path/that/does/not/exist", {}).mastermind;

    expect(() =>
      resolveLiveWebhookConfiguration(
        {
          ...defaults,
          publicWebhookUrl: "https://mastermind.example.com/channels/linear/webhook",
        },
        {},
      ),
    ).toThrow(
      "Persistent Mastermind webhook configuration missing: mastermind.linear_webhook_id, LINEAR_WEBHOOK_SECRET",
    );
  });

  it("uses temporary setup only when no persistent value or secret is configured", () => {
    const defaults = loadTypedWeavekitConfig("/path/that/does/not/exist", {}).mastermind;

    expect(resolveLiveWebhookConfiguration(defaults, {})).toEqual({
      mode: "temporary",
    });
    expect(() =>
      resolveLiveWebhookConfiguration(defaults, {
        LINEAR_WEBHOOK_SECRET: "orphaned-secret",
      }),
    ).toThrow(
      "Persistent Mastermind webhook configuration missing: mastermind.public_webhook_url, mastermind.linear_webhook_id",
    );
  });

  it("discovers Linear setup and creates live resources", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      const query = String(request.query);
      if (query.includes("MastermindLiveSetup")) {
        return Response.json({
          data: {
            organization: { id: "organization-one", name: "Example" },
            teams: { nodes: [{ id: "team-one", name: "Platform" }] },
            issueLabels: { nodes: [] },
          },
        });
      }
      if (query.includes("MastermindLiveIssues")) {
        return Response.json({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-one",
                  identifier: "WK-1",
                  title: "Review me",
                  project: { id: "project-one", name: "Weavekit" },
                  labels: { nodes: [] },
                },
              ],
            },
          },
        });
      }
      if (query.includes("MastermindLiveCreateLabel")) {
        return Response.json({
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: {
                id: "label-one",
                name: "mastermind-reviewed",
              },
            },
          },
        });
      }
      if (query.includes("MastermindLiveCreateWebhook")) {
        return Response.json({
          data: {
            webhookCreate: {
              success: true,
              webhook: { id: "webhook-one", enabled: true },
            },
          },
        });
      }
      return Response.json({
        data: { webhookDelete: { success: true } },
      });
    };
    const client = new LinearSetupClient("test-key", fetcher);

    await expect(client.getSetup()).resolves.toEqual({
      organization: { id: "organization-one", name: "Example" },
      teams: [{ id: "team-one", name: "Platform" }],
      labels: [],
    });
    await expect(client.listIssues("team-one")).resolves.toEqual([
      {
        id: "issue-one",
        identifier: "WK-1",
        title: "Review me",
        projectId: "project-one",
        projectName: "Weavekit",
        labels: [],
      },
    ]);
    await expect(client.createLabel("team-one", "mastermind-reviewed")).resolves.toEqual({
      id: "label-one",
      name: "mastermind-reviewed",
    });
    await expect(
      client.createWebhook("team-one", "https://example.trycloudflare.com/channels/linear/webhook"),
    ).resolves.toBe("webhook-one");
    await expect(client.deleteWebhook("webhook-one")).resolves.toBeUndefined();

    expect(requests[1]?.query).toContain("query MastermindLiveIssues($teamId: ID!)");
    expect(requests[2]?.variables).toEqual({
      input: {
        teamId: "team-one",
        name: "mastermind-reviewed",
        description: "Managed by weavekit-mastermind ticket review.",
        color: "#5E6AD2",
      },
    });
    expect(requests[3]?.variables).toEqual({
      input: {
        teamId: "team-one",
        url: "https://example.trycloudflare.com/channels/linear/webhook",
        resourceTypes: ["Issue"],
      },
    });
  });
});
