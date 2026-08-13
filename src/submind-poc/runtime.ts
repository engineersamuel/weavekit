import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { SubmindRunState } from "./contracts.js";
import { SubmindController, stageSubmindSkill, type ControllerDependencies } from "./controller.js";
import { canonicalRepository, provisionHerdrWorktree } from "./provision.js";
import { ScopedHerdr } from "./scope.js";
import type { HerdrSocketClient } from "./socket.js";
import { createHerdrClient, isAmbiguousHerdrMutation, withHerdrClient } from "../herdr/client.js";

const interactiveCommands = ["copilot", "grx", "codx", "trellage"] as const;

export async function createDefaultController(controlRoot: string): Promise<SubmindController> {
  const dependencies: ControllerDependencies = {
    controlRoot,
    canonicalRepository,
    provision: provisionHerdrWorktree,
    stageSkill: stageSubmindSkill,
    preflight: async (input) => {
      await withHerdrClient(input.worktreePath, async (client) => {
        const scoped = new ScopedHerdr(client, {
          workspaceId: input.workspaceId,
          worktreePath: input.worktreePath,
          agentPrefix: "submind-preflight-",
        });
        const snapshot = await scoped.snapshot();
        const pane = snapshot.panes.find((candidate) => candidate.id === input.paneId);
        if (!pane || pane.workspaceId !== input.workspaceId || pane.exited) {
          throw new Error("Herdr root pane is unavailable for interactive preflight.");
        }
        const marker = `__SUBMIND_PREFLIGHT_${process.pid}__`;
        const script = interactiveCommands
          .map(
            (command) =>
              `type ${command} >/dev/null 2>&1 && printf '${marker}${command}=ok\\n' || printf '${marker}${command}=missing\\n'`,
          )
          .join("; ");
        await client.request(
          "pane.send_input",
          {
            pane_id: input.paneId,
            text: script,
            keys: ["Enter"],
          },
          z.unknown(),
        );
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const raw = await client.request(
            "pane.read",
            { pane_id: input.paneId, source: "visible", lines: 40 },
            z.unknown(),
          );
          const text = extractText(raw);
          const results = parsePreflightResults(text, marker);
          if (interactiveCommands.every((command) => results[command])) {
            const missing = Object.entries(results)
              .filter(([, status]) => status === "missing")
              .map(([command]) => command);
            if (missing.length > 0) {
              throw new Error(`Unavailable interactive-shell command: ${missing.join(", ")}`);
            }
            return;
          }
          await delay(250);
        }
        throw new Error("Timed out waiting for interactive-shell command preflight.");
      });
    },
    startOrchestrator: async (input) =>
      withHerdrClient(input.worktreePath, async (client) => {
        const scoped = new ScopedHerdr(client, input);
        const initialSnapshot = await scoped.snapshot();
        const existing = initialSnapshot.agents.find((candidate) => candidate.name === input.name);
        if (existing) {
          const pane = initialSnapshot.panes.find((candidate) => candidate.id === existing.paneId);
          if (!pane || pane.workspaceId !== input.workspaceId) {
            throw new Error(`Orchestrator name collision outside run workspace: ${input.name}`);
          }
        }
        if (!existing) {
          let ambiguousLaunch: Error | undefined;
          let launched = false;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
              await scoped.launch({
                paneId: input.paneId,
                name: input.name,
                kind: "copilot",
                command: input.command,
                args: input.args,
              });
              launched = true;
              break;
            } catch (error) {
              if (isAmbiguousHerdrMutation(error)) {
                ambiguousLaunch = error instanceof Error ? error : new Error(String(error));
                break;
              }
              if (!String(error).includes("agent_pane_busy")) throw error;
              await delay(250);
            }
          }
          if (!launched && !ambiguousLaunch) {
            throw new Error("Timed out waiting for the Herdr root shell to become available.");
          }
          for (let attempt = 0; attempt < 40 && ambiguousLaunch; attempt += 1) {
            const snapshot = await scoped.snapshot();
            const adopted = snapshot.agents.find((candidate) => candidate.name === input.name);
            if (adopted) {
              const pane = snapshot.panes.find((candidate) => candidate.id === adopted.paneId);
              if (!pane || pane.workspaceId !== input.workspaceId) {
                throw new Error(`Orchestrator name collision outside run workspace: ${input.name}`);
              }
              if (adopted.kind === undefined || adopted.interactiveReady !== true) {
                await delay(250);
                continue;
              }
              assertCopilotOrchestratorKind(adopted.kind);
              return { agentId: adopted.id };
            }
            await delay(250);
          }
          if (ambiguousLaunch) throw ambiguousLaunch;
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const snapshot = await scoped.snapshot();
          const agent = snapshot.agents.find((candidate) => candidate.name === input.name);
          if (agent) {
            const pane = snapshot.panes.find((candidate) => candidate.id === agent.paneId);
            if (!pane || pane.workspaceId !== input.workspaceId) {
              throw new Error(`Orchestrator name collision outside run workspace: ${input.name}`);
            }
            if (agent.kind === undefined || agent.interactiveReady !== true) {
              await delay(250);
              continue;
            }
            assertCopilotOrchestratorKind(agent.kind);
            return { agentId: agent.id };
          }
          await delay(250);
        }
        throw new Error("Timed out waiting for Copilot orchestrator detection.");
      }),
    promptOrchestrator: async (input) =>
      withHerdrClient(input.worktreePath, async (client) => {
        const scoped = new ScopedHerdr(client, input);
        await scoped.prompt(input.agentId, input.prompt);
        await scoped.wait(input.agentId, ["working", "blocked", "done"], 30_000);
      }),
    inspectLive: async (state) => inspectLive(state),
  };
  return new SubmindController(dependencies);
}

export function assertCopilotOrchestratorKind(kind: string | undefined): void {
  if (kind !== "copilot") throw new Error(`Wrong detected orchestrator kind: ${String(kind)}`);
}

export function parsePreflightResults(
  text: string,
  marker: string,
): Partial<Record<(typeof interactiveCommands)[number], "ok" | "missing">> {
  const results: Partial<Record<(typeof interactiveCommands)[number], "ok" | "missing">> = {};
  for (const line of text.split(/\r?\n/u)) {
    for (const command of interactiveCommands) {
      for (const status of ["ok", "missing"] as const) {
        if (line === `${marker}${command}=${status}`) results[command] = status;
      }
    }
  }
  return results;
}

export async function createScopedHerdrForRun(state: SubmindRunState): Promise<{
  client: HerdrSocketClient;
  scoped: ScopedHerdr;
}> {
  if (!state.workspaceId || !state.worktreePath)
    throw new Error("Run has no provisioned workspace.");
  const client = await createHerdrClient(state.worktreePath);
  return {
    client,
    scoped: new ScopedHerdr(client, {
      workspaceId: state.workspaceId,
      worktreePath: state.worktreePath,
      agentPrefix: state.agentPrefix,
    }),
  };
}

async function inspectLive(
  state: SubmindRunState,
): Promise<"active" | "done" | "failed" | "unknown" | "unavailable"> {
  if (!state.orchestratorAgentId || !state.workspaceId || !state.worktreePath) return "unknown";
  try {
    const { client, scoped } = await createScopedHerdrForRun(state);
    try {
      const agent = (await scoped.snapshot()).agents.find(
        (candidate) => candidate.id === state.orchestratorAgentId,
      );
      if (!agent) return "unknown";
      return classifyOrchestratorStatus(agent.status);
    } finally {
      client.close();
    }
  } catch {
    return "unavailable";
  }
}

export function classifyOrchestratorStatus(
  status: string | undefined,
): "active" | "done" | "failed" | "unknown" {
  if (status === "done" || status === "idle" || status === "working") return "active";
  if (["blocked", "failed", "unknown", "exited"].includes(status ?? "")) return "failed";
  return "unknown";
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "output"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return Object.values(record).map(extractText).join("\n");
}
