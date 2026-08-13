import { setTimeout as delay } from "node:timers/promises";
import { isAmbiguousHerdrMutation } from "../../herdr/client.js";
import { HerdrAgentStatus } from "../../herdr/contracts.js";
import type { ScopedHerdr } from "../../herdr/scope.js";
import {
  TRELLAGE_EXITED_STATUS,
  type TrellageBackend,
  type TrellageLaunchInput,
  type TrellageSession,
} from "./backend.js";
import { buildTrellageCommand } from "./catalog.js";

const ADOPTION_POLL_INTERVAL_MS = 500;
const RENAME_ATTEMPTS = 10;

export type HerdrTrellageBackendOptions = {
  /**
   * How long to wait for Herdr to detect an agent in the launched pane. Container profiles pay a
   * Docker start plus a harness boot before any agent is detectable, so this is deliberately long.
   */
  adoptionTimeoutMs?: number;
  /** Injected so tests can drive adoption polling without real timers. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Drives Trellage through Herdr, which owns the PTY.
 *
 * `trellage` refuses to run without a controlling terminal, so the launch path must *type* the
 * command into a real pane (`pane.send_input`) rather than spawn it. Herdr then detects the
 * underlying agent and adopts it, which is what makes `agent.wait`/`agent.prompt` available for a
 * binary Herdr does not recognize by name.
 */
export function createHerdrTrellageBackend(
  scoped: ScopedHerdr,
  options: HerdrTrellageBackendOptions = {},
): TrellageBackend {
  const adoptionTimeoutMs = options.adoptionTimeoutMs ?? 300_000;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));

  return {
    async launch(input: TrellageLaunchInput): Promise<TrellageSession> {
      const tab = await scoped.createTab(input.label);
      try {
        const [command, ...args] = buildTrellageCommand(input.profile, input.model, input.effort);
        try {
          await scoped.launch({
            paneId: tab.id,
            name: input.label,
            command: command!,
            args,
            interactive: true,
          });
        } catch (error) {
          // `pane.send_input` is reconnect-unsafe: an ambiguous failure means the keystrokes may
          // already have landed. Re-observe via adoption polling instead of typing them twice.
          if (!isAmbiguousHerdrMutation(error)) throw error;
        }

        const agent = await pollForAdoption(scoped, tab.id, adoptionTimeoutMs, sleep);
        await renameToScopedName(scoped, agent.id, input.label);
        return { agentId: agent.id, paneId: tab.id, tabId: tab.tabId, kind: agent.kind };
      } catch (error) {
        await closeQuietly(scoped, tab.tabId);
        throw error;
      }
    },

    async prompt(session, text) {
      await scoped.prompt(session.agentId, text);
    },

    async waitForState(session, states, timeoutMs) {
      await scoped.wait(session.agentId, [...states], timeoutMs);
      // `agent.wait` resolves on the state it observed but does not report it, and Herdr tracks
      // lifecycle state rather than turns, so the drive loop must re-read the state it landed on.
      return this.status(session);
    },

    async status(session) {
      const snapshot = await scoped.snapshot();
      const pane = snapshot.panes.find((candidate) => candidate.id === session.paneId);
      if (!pane || pane.exited) return TRELLAGE_EXITED_STATUS;
      const agent = snapshot.agents.find((candidate) => candidate.id === session.agentId);
      return agent?.status ?? HerdrAgentStatus.Unknown;
    },

    async read(session, readOptions = {}) {
      const { text } = await scoped.read(session.agentId, readOptions);
      return text;
    },

    async sendKeys(session, keys) {
      await scoped.sendKeys(session.agentId, keys);
    },

    async dispose(session) {
      await closeQuietly(scoped, session.tabId);
    },
  };
}

async function pollForAdoption(
  scoped: ScopedHerdr,
  paneId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ id: string; kind?: string }> {
  const deadline = Date.now() + timeoutMs;
  let sawPane = false;
  while (Date.now() < deadline) {
    const snapshot = await scoped.snapshot();
    const pane = snapshot.panes.find((candidate) => candidate.id === paneId);
    if (pane) sawPane = true;
    if (sawPane && (!pane || pane.exited)) {
      throw new Error(`Trellage pane exited before an agent was detected: ${paneId}`);
    }
    const agent = snapshot.agents.find((candidate) => candidate.paneId === paneId);
    if (agent?.kind) return { id: agent.id, kind: agent.kind };
    await sleep(ADOPTION_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Herdr to detect a Trellage agent in pane ${paneId}.`,
  );
}

/**
 * Gives the adopted agent a run-scoped name.
 *
 * This is not cosmetic: every `ScopedHerdr` guard checks the agent's name prefix, so a session
 * whose rename never lands cannot be prompted or read afterwards. Retries absorb the window where
 * Herdr has detected the agent but not yet finished registering it.
 */
async function renameToScopedName(
  scoped: ScopedHerdr,
  agentId: string,
  name: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await scoped.rename(agentId, name);
      return;
    } catch (error) {
      // An ambiguous rename may have landed; confirm from the snapshot rather than retrying.
      if (isAmbiguousHerdrMutation(error)) {
        const snapshot = await scoped.snapshot();
        if (snapshot.agents.some((agent) => agent.id === agentId && agent.name === name)) return;
      }
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(
    `Failed to assign the run-scoped name "${name}" to Trellage agent ${agentId}: ${String(lastError)}`,
  );
}

async function closeQuietly(scoped: ScopedHerdr, tabId: string): Promise<void> {
  try {
    await scoped.closeTab(tabId);
  } catch {
    // Cleanup is advisory; a tab that is already gone, or that Herdr refuses to close, must not
    // mask the real result of the invocation.
  }
}
