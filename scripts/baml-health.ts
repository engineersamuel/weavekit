import { readFile } from "node:fs/promises";
import { b } from "../src/generated/baml_client/index.js";

type BamlClientDefinition = {
  name: string;
  provider: string;
  model: string;
};

type ProxyModel = {
  slug: string;
  supported_endpoints?: string[];
};

const ACTIVE_CLIENTS = [
  "CopilotProxyGpt55",
  "CopilotProxyClaudeOpus48",
  "CopilotProxyGpt5Mini",
  "CopilotProxyGpt54",
] as const;

const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:8080/v1";

process.env.COPILOT_PROXY_API_KEY ??= "local";

async function main() {
  const baseUrl = process.env.COPILOT_PROXY_BASE_URL ?? DEFAULT_PROXY_BASE_URL;
  const clients = await parseBamlClients("baml_src/clients.baml");
  const proxyModels = await fetchProxyModels(baseUrl);

  const selectedClients = ACTIVE_CLIENTS.map((name) => {
    const client = clients.get(name);
    if (!client) {
      throw new Error(`Missing BAML client ${name}`);
    }
    return client;
  });

  console.log("BAML client static health");
  console.log("| Client | Provider | Model | Proxy model | Advertised endpoint |");
  console.log("| --- | --- | --- | --- | --- |");
  let failed = false;
  for (const client of selectedClients) {
    const proxyModel = proxyModels.get(client.model);
    const endpoint = expectedEndpoint(client.provider);
    const endpointOk = endpoint ? proxyModel?.supported_endpoints?.includes(endpoint) === true : true;
    if (!proxyModel || !endpointOk) {
      failed = true;
    }
    console.log(
      `| ${client.name} | ${client.provider} | ${client.model} | ${proxyModel ? "yes" : "no"} | ${
        endpoint ? (endpointOk ? endpoint : `missing ${endpoint}`) : "n/a"
      } |`,
    );
  }

  if (process.argv.includes("--static")) {
    process.exit(failed ? 1 : 0);
  }

  console.log("\nBAML live function health");
  console.log("| Function | Client | Status | Detail |");
  console.log("| --- | --- | --- | --- |");

  for (const probe of liveProbes()) {
    const started = Date.now();
    try {
      await probe.call();
      console.log(`| ${probe.name} | ${probe.client} | passed | ${Date.now() - started}ms |`);
    } catch (error) {
      failed = true;
      console.log(`| ${probe.name} | ${probe.client} | failed | ${formatError(error)} |`);
    }
  }

  process.exit(failed ? 1 : 0);
}

async function parseBamlClients(path: string): Promise<Map<string, BamlClientDefinition>> {
  const baml = await readFile(path, "utf8");
  const clients = new Map<string, BamlClientDefinition>();
  const clientPattern = /client<llm>\s+(\w+)\s*\{([\s\S]*?)(?=\nclient<llm>|\n*$)/g;
  for (const match of baml.matchAll(clientPattern)) {
    const [, name, block] = match;
    if (!name || !block) {
      continue;
    }
    const provider = block.match(/provider\s+"([^"]+)"/)?.[1];
    const model = block.match(/model\s+"([^"]+)"/)?.[1];
    if (provider && model) {
      clients.set(name, { name, provider, model });
    }
  }
  return clients;
}

async function fetchProxyModels(baseUrl: string): Promise<Map<string, ProxyModel>> {
  const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
  const response = await fetch(`${rootUrl}/v1/models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch proxy models from ${rootUrl}/v1/models: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: Array<{ id: string }>; models?: ProxyModel[] };
  const models = new Map<string, ProxyModel>();
  for (const item of payload.data ?? []) {
    models.set(item.id, { slug: item.id });
  }
  for (const item of payload.models ?? []) {
    models.set(item.slug, item);
  }
  return models;
}

function expectedEndpoint(provider: string): string | undefined {
  if (provider === "openai-generic") {
    return "/chat/completions";
  }
  if (provider === "openai-responses") {
    return "/responses";
  }
  return undefined;
}

function liveProbes(): Array<{ name: string; client: string; call: () => Promise<unknown> }> {
  const currentPlan = {
    id: "health-plan",
    objective: "BAML health check",
    templateId: "implementation-review",
    maxReplans: 1,
    nodes: [
      {
        id: "source-reading",
        kind: "research",
        harness: "copilot-sdk",
        title: "Read source artifact",
        description: "Health-check fixture node.",
        model: "gpt-5.5",
        modelRationale: "Fixture for primary research model metadata.",
        prompt: "Read source artifact.",
        dependsOn: [],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "on-contract-failure",
      },
    ],
  };

  return [
    {
      name: "PlanWorkflow",
      client: "CopilotProxyClaudeOpus48",
      call: () => b.PlanWorkflow("BAML health check", "Create a minimal implementation-review DAG.", "implementation-review", { client: "CopilotProxyClaudeOpus48" }),
    },
    {
      name: "GenerateReplanPatch",
      client: "CopilotProxyClaudeOpus48",
      call: () => b.GenerateReplanPatch("Health-check retry after timeout.", 1, [], currentPlan, { client: "CopilotProxyClaudeOpus48" }),
    },
    {
      name: "RouteModelCall",
      client: "CopilotProxyGpt5Mini",
      call: () => b.RouteModelCall("normalize", "Health-check fast routing.", ["CopilotProxyGpt5Mini"], { client: "CopilotProxyGpt5Mini" }),
    },
    {
      name: "DistillSourceAnalysis",
      client: "CopilotProxyGpt55",
      call: () =>
        b.DistillSourceAnalysis(
          JSON.stringify({ source: "health-check", kind: "inline" }),
          "The source says the health check should return a concise structured result.",
          { client: "CopilotProxyGpt55" },
        ),
    },
  ];
}

function formatError(error: unknown): string {
  if (error && typeof error === "object") {
    const raw = "raw_response" in error ? String((error as { raw_response?: unknown }).raw_response ?? "") : "";
    const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
    return compact(raw || message || String(error));
  }
  return compact(String(error));
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 220);
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
