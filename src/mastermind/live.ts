import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { serve, type ServerType } from "@hono/node-server";
import type { WeavekitConfig } from "../config.js";
import { resolveProjectCatalogEntry } from "../config.js";
import { createMastermindApp } from "./app.js";
import { GeneratedMastermindDecisionProvider } from "./decision/bamlAdapters.js";
import { MastermindDecisionLoop } from "./decision/loop.js";
import { MastermindState } from "./domain/events.js";
import { resolveMastermindFailureReasons } from "./failure.js";
import { LinearGraphQlGateway } from "./linear/client.js";
import { createTicketReviewHarness } from "./review/harness.js";
import { MastermindService } from "./service.js";
import { SqliteMastermindStore } from "./store/sqlite.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const WEBHOOK_PATH = "/channels/linear/webhook";
const TERMINAL_STATES = new Set<MastermindState>([
  MastermindState.ACTION_PLANNED,
  MastermindState.NEEDS_HUMAN,
  MastermindState.IGNORED,
  MastermindState.FAILED,
]);

export type LinearSetup = {
  organization: { id: string; name: string };
  teams: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string }>;
};

export type LinearSetupIssue = {
  id: string;
  identifier: string;
  title: string;
  projectId?: string;
  projectName?: string;
  labels: Array<{ id: string; name: string }>;
};

export class LinearSetupClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getSetup(): Promise<LinearSetup> {
    const data = await this.query(`
      query MastermindLiveSetup {
        organization { id name }
        teams { nodes { id name } }
        issueLabels { nodes { id name } }
      }
    `);
    const organization = asRecord(data.organization);
    if (typeof organization.id !== "string") {
      throw new Error("Linear did not return an organization for this API key.");
    }
    return {
      organization: {
        id: organization.id,
        name: String(organization.name ?? organization.id),
      },
      teams: asNodes(data.teams).flatMap((value) => {
        const team = asRecord(value);
        return typeof team.id === "string"
          ? [{ id: team.id, name: String(team.name ?? team.id) }]
          : [];
      }),
      labels: asNodes(data.issueLabels).flatMap((value) => {
        const label = asRecord(value);
        return typeof label.id === "string"
          ? [{ id: label.id, name: String(label.name ?? label.id) }]
          : [];
      }),
    };
  }

  async listIssues(teamId: string): Promise<LinearSetupIssue[]> {
    const data = await this.query(
      `query MastermindLiveIssues($teamId: ID!) {
        issues(first: 25, filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            identifier
            title
            project { id name }
            labels { nodes { id name } }
          }
        }
      }`,
      { teamId },
    );
    return asNodes(data.issues).flatMap((value) => {
      const issue = asRecord(value);
      if (typeof issue.id !== "string") {
        return [];
      }
      const project = asRecord(issue.project);
      return [
        {
          id: issue.id,
          identifier: String(issue.identifier ?? issue.id),
          title: String(issue.title ?? ""),
          projectId: typeof project.id === "string" ? project.id : undefined,
          projectName: typeof project.name === "string" ? project.name : undefined,
          labels: asNodes(issue.labels).flatMap((labelValue) => {
            const label = asRecord(labelValue);
            return typeof label.id === "string"
              ? [{ id: label.id, name: String(label.name ?? label.id) }]
              : [];
          }),
        },
      ];
    });
  }

  async createLabel(teamId: string, name: string): Promise<{ id: string; name: string }> {
    const data = await this.query(
      `mutation MastermindLiveCreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      {
        input: {
          teamId,
          name,
          description: "Managed by weavekit-mastermind ticket review.",
          color: "#5E6AD2",
        },
      },
    );
    const result = asRecord(data.issueLabelCreate);
    const label = asRecord(result.issueLabel);
    if (result.success !== true || typeof label.id !== "string") {
      throw new Error(`Linear rejected creation of the Mastermind label ${name}.`);
    }
    return { id: label.id, name: String(label.name ?? name) };
  }

  async createWebhook(teamId: string, url: string): Promise<string> {
    const data = await this.query(
      `mutation MastermindLiveCreateWebhook($input: WebhookCreateInput!) {
        webhookCreate(input: $input) {
          success
          webhook { id enabled }
        }
      }`,
      {
        input: {
          teamId,
          url,
          resourceTypes: ["Issue"],
        },
      },
    );
    const result = asRecord(data.webhookCreate);
    const webhook = asRecord(result.webhook);
    if (result.success !== true || typeof webhook.id !== "string") {
      throw new Error("Linear rejected creation of the Mastermind webhook.");
    }
    return webhook.id;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const data = await this.query(
      `mutation MastermindLiveDeleteWebhook($id: String!) {
        webhookDelete(id: $id) { success }
      }`,
      { id: webhookId },
    );
    if (asRecord(data.webhookDelete).success !== true) {
      throw new Error(`Linear rejected deletion of webhook ${webhookId}.`);
    }
  }

  private async query(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(LINEAR_API_URL, {
      method: "POST",
      headers: {
        authorization: this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const envelope = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok) {
      const details = envelope.errors?.map((error) => error.message ?? "unknown").join("; ");
      throw new Error(
        `Linear setup request failed with HTTP ${response.status}${details ? `: ${details}` : "."}`,
      );
    }
    if (envelope.errors?.length) {
      throw new Error(
        `Linear setup error: ${envelope.errors
          .map((error) => error.message ?? "unknown")
          .join("; ")}`,
      );
    }
    if (!envelope.data) {
      throw new Error("Linear setup response did not include data.");
    }
    return envelope.data;
  }
}

export function extractQuickTunnelUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu)?.[0];
}

export async function startCloudflareQuickTunnel(
  localUrl: string,
  options: {
    executable?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  process: ChildProcessWithoutNullStreams;
  publicUrl: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-cloudflared-"));
  const configPath = join(directory, "config.yml");
  await writeFile(configPath, "{}\n");
  const child = spawn(
    options.executable ?? "cloudflared",
    ["tunnel", "--config", configPath, "--no-autoupdate", "--url", localUrl],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end();
  const timeoutMs = options.timeoutMs ?? 30_000;
  let output = "";
  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Cloudflare Quick Tunnel URL."));
    }, timeoutMs);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const url = extractQuickTunnelUrl(output);
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`cloudflared exited before publishing a URL (exit ${String(code)}): ${output}`),
      );
    });
  }).catch(async (error) => {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  return {
    process: child,
    publicUrl,
    async cleanup() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function startCloudflareNamedTunnel(
  tunnelName: string,
  options: {
    configPath?: string;
    executable?: string;
    startupGraceMs?: number;
  } = {},
): Promise<{
  process: ChildProcessWithoutNullStreams;
  cleanup(): Promise<void>;
}> {
  const args = [
    "tunnel",
    ...(options.configPath ? ["--config", options.configPath] : []),
    "--no-autoupdate",
    "run",
    tunnelName,
  ];
  const child = spawn(options.executable ?? "cloudflared", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, options.startupGraceMs ?? 1_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `cloudflared exited while starting tunnel ${tunnelName} (exit ${String(code)}): ${output}`,
        ),
      );
    });
  }).catch(async (error) => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    throw error;
  });
  return {
    process: child,
    async cleanup() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    },
  };
}

export type LiveWebhookConfiguration =
  | {
      mode: "persistent";
      webhookId: string;
      webhookUrl: string;
      webhookSecret: string;
      cloudflareTunnel?: string;
      cloudflareTunnelConfig?: string;
    }
  | {
      mode: "temporary";
    };

export function resolveLiveWebhookConfiguration(
  config: WeavekitConfig["mastermind"],
  env: NodeJS.ProcessEnv = process.env,
): LiveWebhookConfiguration {
  const webhookSecret = env.LINEAR_WEBHOOK_SECRET?.trim();
  const configuredValues = [
    config.publicWebhookUrl,
    config.linearWebhookId,
    config.cloudflareTunnel,
    config.cloudflareTunnelConfig,
    webhookSecret,
  ];
  if (configuredValues.every((value) => !value)) {
    return { mode: "temporary" };
  }
  const missing: string[] = [];
  if (!config.publicWebhookUrl) missing.push("mastermind.public_webhook_url");
  if (!config.linearWebhookId) missing.push("mastermind.linear_webhook_id");
  if (!webhookSecret) missing.push("LINEAR_WEBHOOK_SECRET");
  if (config.cloudflareTunnelConfig && !config.cloudflareTunnel) {
    missing.push("mastermind.cloudflare_tunnel");
  }
  if (missing.length > 0) {
    throw new Error(`Persistent Mastermind webhook configuration missing: ${missing.join(", ")}`);
  }
  const webhookUrl = new URL(config.publicWebhookUrl!);
  if (webhookUrl.protocol !== "https:") {
    throw new Error("mastermind.public_webhook_url must use HTTPS.");
  }
  if (webhookUrl.pathname !== config.webhookPath) {
    throw new Error(
      `mastermind.public_webhook_url must end with the configured webhook path ${config.webhookPath}.`,
    );
  }
  return {
    mode: "persistent",
    webhookId: config.linearWebhookId!,
    webhookUrl: webhookUrl.toString(),
    webhookSecret: webhookSecret!,
    ...(config.cloudflareTunnel ? { cloudflareTunnel: config.cloudflareTunnel } : {}),
    ...(config.cloudflareTunnelConfig
      ? { cloudflareTunnelConfig: config.cloudflareTunnelConfig }
      : {}),
  };
}

export async function runMastermindLive(baseConfig: WeavekitConfig): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY is required. Add an admin-capable personal API key as the root LINEAR_API_KEY value in ~/.weavekit/config.toml.",
    );
  }
  resolveProjectCatalogEntry(
    baseConfig,
    process.env.MASTERMIND_PROJECT_ID?.trim() ||
      baseConfig.mastermind.projectMappings[0]?.projectId ||
      "weavekit",
  );
  await assertProxyHealthy();

  const linearSetup = new LinearSetupClient(apiKey);
  const setup = await linearSetup.getSetup();
  const team = await selectTeam(setup.teams);
  const reviewedLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.reviewedLabelName,
  );
  const readyLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.readyLabelName,
  );
  const needsInputLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.needsInputLabelName,
  );
  const reviewFailedLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.reviewFailedLabelName,
  );
  const codeReviewLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.codeReviewLabelName ?? "mastermind-code-review",
  );
  const codeReviewPassedLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.codeReviewPassedLabelName ?? "mastermind-code-review-passed",
  );
  const changesRequestedLabel = await findOrCreateLabel(
    linearSetup,
    setup.labels,
    team.id,
    baseConfig.mastermind.changesRequestedLabelName ?? "mastermind-changes-requested",
  );
  const issues = await linearSetup.listIssues(team.id);
  const issue = await selectIssue(issues, reviewedLabel.id);
  if (!issue.projectId) {
    throw new Error(
      `Linear issue ${issue.identifier} has no project. Add it to a project and rerun.`,
    );
  }

  const localUrl = `http://${baseConfig.mastermind.host}:${baseConfig.mastermind.port}`;
  const webhookConfiguration = resolveLiveWebhookConfiguration(baseConfig.mastermind);
  let tunnel: { cleanup(): Promise<void> } | undefined;
  let webhookUrl: string;
  let webhookId: string;
  if (webhookConfiguration.mode === "persistent") {
    webhookUrl = webhookConfiguration.webhookUrl;
    webhookId = webhookConfiguration.webhookId;
    if (webhookConfiguration.cloudflareTunnel) {
      tunnel = await startCloudflareNamedTunnel(webhookConfiguration.cloudflareTunnel, {
        configPath: webhookConfiguration.cloudflareTunnelConfig,
      });
    }
  } else {
    const quickTunnel = await startCloudflareQuickTunnel(localUrl);
    tunnel = quickTunnel;
    webhookUrl = `${quickTunnel.publicUrl}${WEBHOOK_PATH}`;
    webhookId = "";
  }
  const deleteWebhookOnExit = webhookConfiguration.mode === "temporary";
  let server: ServerType | undefined;
  let service: MastermindService | undefined;
  try {
    if (webhookConfiguration.mode === "temporary") {
      webhookId = await linearSetup.createWebhook(team.id, webhookUrl);
      printTemporarySetupInstructions({
        organization: setup.organization.name,
        team: team.name,
        issue,
        webhookId,
        webhookUrl,
      });
    } else {
      printPersistentSetup({
        organization: setup.organization.name,
        team: team.name,
        issue,
        webhookId,
        webhookUrl,
        tunnelManaged: Boolean(webhookConfiguration.cloudflareTunnel),
      });
    }
    const webhookSecret =
      webhookConfiguration.mode === "persistent"
        ? webhookConfiguration.webhookSecret
        : await readSecret("Signing secret: ");
    if (!webhookSecret) {
      throw new Error("Linear webhook signing secret is required.");
    }
    const projectId =
      process.env.MASTERMIND_PROJECT_ID?.trim() ||
      baseConfig.mastermind.projectMappings[0]?.projectId ||
      "weavekit";
    const config: WeavekitConfig = {
      ...baseConfig,
      mastermind: {
        ...baseConfig.mastermind,
        enabled: true,
        webhookPath: WEBHOOK_PATH,
        linearOrganizationId: setup.organization.id,
        linearWebhookId: webhookId,
        reviewedLabelId: reviewedLabel.id,
        reviewedLabelName: reviewedLabel.name,
        readyLabelId: readyLabel.id,
        readyLabelName: readyLabel.name,
        needsInputLabelId: needsInputLabel.id,
        needsInputLabelName: needsInputLabel.name,
        reviewFailedLabelId: reviewFailedLabel.id,
        reviewFailedLabelName: reviewFailedLabel.name,
        codeReviewLabelId: codeReviewLabel.id,
        codeReviewLabelName: codeReviewLabel.name,
        codeReviewPassedLabelId: codeReviewPassedLabel.id,
        codeReviewPassedLabelName: codeReviewPassedLabel.name,
        changesRequestedLabelId: changesRequestedLabel.id,
        changesRequestedLabelName: changesRequestedLabel.name,
        projectMappings: [
          {
            teamId: team.id,
            linearProjectId: issue.projectId,
            projectId,
          },
        ],
      },
    };
    const store = new SqliteMastermindStore(config.mastermind.sqlitePath);
    const linear = new LinearGraphQlGateway(apiKey);
    const decisions = new GeneratedMastermindDecisionProvider(undefined, {
      synthesisModel: config.mastermind.synthesisModel,
    });
    const reviewHarness = createTicketReviewHarness(config);
    let currentReviewPhase = "Starting review.";
    const reportReviewProgress = (message: string) => {
      const lines = message.split("\n");
      currentReviewPhase = lines[0] ?? message;
      stdout.write(`${lines.map((line) => `[mastermind] ${line}`).join("\n")}\n`);
    };
    const loop = new MastermindDecisionLoop(
      config,
      store,
      linear,
      decisions,
      reviewHarness,
      reportReviewProgress,
    );
    const { createMastermindExecutionCoordinator } = await import("./execution/factory.js");
    service = new MastermindService(
      config.mastermind,
      store,
      loop,
      createMastermindExecutionCoordinator(config, store, linear, (message) => {
        stdout.write(`[mastermind] execution ${message}\n`);
      }),
    );
    await service.start();
    const app = createMastermindApp({
      config: config.mastermind,
      webhookSecret,
      store,
      service,
    });
    server = serve({
      fetch: app.fetch,
      hostname: config.mastermind.host,
      port: config.mastermind.port,
    });
    await waitForHealthy(`${localUrl}/ready`);
    const delivery = await store.ingestDelivery({
      deliveryId: randomUUID(),
      organizationId: setup.organization.id,
      webhookId,
      eventType: "Issue",
      action: "live-smoke",
      issueId: issue.id,
    });
    stdout.write(`\nReviewing ${issue.identifier}: ${issue.title}\n`);
    const reviewStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      stdout.write(
        `[mastermind +${formatElapsed(Date.now() - reviewStartedAt)}] Still working: ${currentReviewPhase}\n`,
      );
    }, 15_000);
    try {
      await service.processAndWait(delivery.workId);
    } finally {
      clearInterval(heartbeat);
    }
    const work = await store.getWork(delivery.workId);
    if (!work || !TERMINAL_STATES.has(work.state)) {
      throw new Error(`Mastermind did not reach a terminal state for ${issue.identifier}.`);
    }
    const updated = await linear.fetchIssue(issue.id);
    const failureReasons =
      work.state === MastermindState.FAILED
        ? await resolveMastermindFailureReasons(store, work.id)
        : [];
    stdout.write(
      [
        `Mastermind state: ${work.state}`,
        `Planned action: ${work.plannedAction ?? "none"}`,
        ...failureReasons.map((reason) => `Failure reason: ${reason}`),
        `Updated title: ${updated.title}`,
        `Labels: ${updated.labels.map((label) => label.name).join(", ") || "none"}`,
        "",
        `Listening for more Linear updates at ${webhookUrl}`,
        deleteWebhookOnExit
          ? "Press Ctrl-C to stop. The temporary Linear webhook will be deleted."
          : "Press Ctrl-C to stop. The persistent Linear webhook will be kept.",
        "",
      ].join("\n"),
    );
    await waitForSignal();
  } finally {
    if (server) {
      await closeServer(server);
    }
    if (service) {
      await service.stop();
    }
    if (deleteWebhookOnExit && webhookId) {
      try {
        await linearSetup.deleteWebhook(webhookId);
      } catch (error) {
        process.stderr.write(
          `Could not delete temporary Linear webhook ${webhookId}: ${formatError(error)}\n`,
        );
      }
    }
    await tunnel?.cleanup();
  }
}

export function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function findOrCreateLabel(
  client: LinearSetupClient,
  labels: Array<{ id: string; name: string }>,
  teamId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return (
    labels.find((label) => label.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ??
    client.createLabel(teamId, name)
  );
}

async function selectTeam(
  teams: Array<{ id: string; name: string }>,
): Promise<{ id: string; name: string }> {
  if (teams.length === 0) {
    throw new Error("Linear did not return any teams.");
  }
  const requested = process.env.MASTERMIND_LINEAR_TEAM?.trim().toLocaleLowerCase();
  if (requested) {
    const match = teams.find(
      (team) =>
        team.id.toLocaleLowerCase() === requested || team.name.toLocaleLowerCase() === requested,
    );
    if (!match) {
      throw new Error(`MASTERMIND_LINEAR_TEAM did not match a Linear team: ${requested}`);
    }
    return match;
  }
  return selectFromList("Select Linear team", teams, (team) => team.name);
}

async function selectIssue(
  issues: LinearSetupIssue[],
  reviewedLabelId: string,
): Promise<LinearSetupIssue> {
  if (issues.length === 0) {
    throw new Error("The selected Linear team has no tickets to review.");
  }
  const requested = process.env.MASTERMIND_LINEAR_ISSUE?.trim().toLocaleLowerCase();
  if (requested) {
    const match = issues.find(
      (issue) =>
        issue.id.toLocaleLowerCase() === requested ||
        issue.identifier.toLocaleLowerCase() === requested,
    );
    if (!match) {
      throw new Error(`MASTERMIND_LINEAR_ISSUE did not match a recent Linear ticket: ${requested}`);
    }
    return match;
  }
  const unreviewed = issues.filter(
    (issue) => !issue.labels.some((label) => label.id === reviewedLabelId),
  );
  return selectFromList(
    "Select first ticket to review",
    unreviewed.length > 0 ? unreviewed : issues,
    (issue) =>
      `${issue.identifier} — ${issue.title}${issue.projectName ? ` [${issue.projectName}]` : ""}`,
  );
}

async function selectFromList<T>(
  heading: string,
  values: T[],
  label: (value: T) => string,
): Promise<T> {
  if (!stdin.isTTY) {
    if (values.length === 1) {
      return values[0]!;
    }
    throw new Error(`${heading} requires an interactive terminal or an environment selector.`);
  }
  stdout.write(`\n${heading}:\n`);
  values.forEach((value, index) => stdout.write(`  ${index + 1}. ${label(value)}\n`));
  const answer = await readLine(`Choice [1]: `);
  const index = answer.trim() === "" ? 0 : Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= values.length) {
    throw new Error(`Invalid selection: ${answer}`);
  }
  return values[index]!;
}

async function readLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new Error("Set LINEAR_WEBHOOK_SECRET when running without an interactive terminal.");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish();
          reject(new Error("Setup cancelled."));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

function printTemporarySetupInstructions(input: {
  organization: string;
  team: string;
  issue: LinearSetupIssue;
  webhookId: string;
  webhookUrl: string;
}): void {
  stdout.write(
    [
      "",
      "Cloudflare Quick Tunnel ready.",
      `Webhook URL: ${input.webhookUrl}`,
      `Linear workspace: ${input.organization}`,
      `Linear team: ${input.team}`,
      `Temporary webhook ID: ${input.webhookId}`,
      `First ticket: ${input.issue.identifier} — ${input.issue.title}`,
      "",
      "Human step:",
      "1. Open https://linear.app/settings/api",
      `2. Open webhook ${input.webhookId}.`,
      "3. Reveal and paste its signing secret below. Input is hidden.",
      "",
    ].join("\n"),
  );
}

function printPersistentSetup(input: {
  organization: string;
  team: string;
  issue: LinearSetupIssue;
  webhookId: string;
  webhookUrl: string;
  tunnelManaged: boolean;
}): void {
  stdout.write(
    [
      "",
      input.tunnelManaged
        ? "Persistent Cloudflare Tunnel started."
        : "Using externally managed persistent webhook endpoint.",
      `Webhook URL: ${input.webhookUrl}`,
      `Linear workspace: ${input.organization}`,
      `Linear team: ${input.team}`,
      `Persistent webhook ID: ${input.webhookId}`,
      `First ticket: ${input.issue.identifier} — ${input.issue.title}`,
      "Signing secret loaded from ~/.weavekit/config.toml.",
      "",
    ].join("\n"),
  );
}

async function assertProxyHealthy(): Promise<void> {
  const baseUrl =
    process.env.COPILOT_PROXY_BASE_URL?.replace(/\/v1\/?$/u, "") ?? "http://127.0.0.1:8080";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    throw new Error(`Copilot model proxy is unavailable at ${baseUrl}: ${formatError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Copilot model proxy health returned HTTP ${response.status}.`);
  }
}

async function waitForHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server may not have bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Mastermind did not become ready at ${url}.`);
}

async function waitForSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNodes(value: unknown): unknown[] {
  const record = asRecord(value);
  return Array.isArray(record.nodes) ? record.nodes : [];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
