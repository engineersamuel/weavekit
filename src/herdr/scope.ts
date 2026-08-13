import { z, type ZodType } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrSnapshotSchema, type HerdrSnapshot } from "./contracts.js";

const AcceptedSchema = z.unknown();
const PaneIdSchema = z.unknown().transform((value, context) => {
  const id = findNestedString(value, "pane_id", "paneId") ?? readRootString(value, "id");
  if (!id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "operation response has no ID" });
    return z.NEVER;
  }
  return { id };
});
const AgentIdSchema = z.unknown().transform((value, context) => {
  const id = findNestedString(value, "pane_id", "paneId", "agent_id", "agentId");
  if (!id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "operation response has no agent ID",
    });
    return z.NEVER;
  }
  return { id };
});
const TabCreatedSchema = z
  .object({
    tab: z.object({ tab_id: z.string().min(1) }).passthrough(),
    root_pane: z.object({ pane_id: z.string().min(1) }).passthrough(),
  })
  .passthrough()
  .transform((value) => ({ id: value.root_pane.pane_id, tabId: value.tab.tab_id }));
const ReadSchema = z.unknown().transform((value, context) => {
  const text = findNestedString(value, "text", "content", "output");
  if (text === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "read response has no text" });
    return z.NEVER;
  }
  return { text };
});

export type HerdrRequester = {
  request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T>;
};

export type ScopedHerdrConfig = {
  workspaceId: string;
  worktreePath: string;
  agentPrefix: string;
};

/**
 * Screen sources exposed by `agent.read`. Agents that render on the terminal's alternate screen
 * return empty text for `recent-unwrapped`, so `visible` and `detection` are the only reliable
 * sources for TUI harnesses.
 */
export const HerdrReadSource = {
  Visible: "visible",
  Recent: "recent",
  RecentUnwrapped: "recent-unwrapped",
  Detection: "detection",
} as const;
export type HerdrReadSource = (typeof HerdrReadSource)[keyof typeof HerdrReadSource];

export class ScopedHerdr {
  /** Tabs this instance created, and therefore the only tabs it is permitted to close. */
  private readonly ownedTabIds = new Set<string>();

  constructor(
    private readonly client: HerdrRequester,
    private readonly config: ScopedHerdrConfig,
  ) {}

  async snapshot(): Promise<HerdrSnapshot> {
    const snapshot = HerdrSnapshotSchema.parse(
      normalizeSnapshot(await this.client.request("session.snapshot", {}, z.unknown())),
    );
    const panes = snapshot.panes.filter((pane) => pane.workspaceId === this.config.workspaceId);
    const paneIds = new Set(panes.map((pane) => pane.id));
    return {
      workspaces: snapshot.workspaces.filter(
        (workspace) => workspace.id === this.config.workspaceId,
      ),
      panes,
      agents: snapshot.agents.filter((agent) => paneIds.has(agent.paneId)),
    };
  }

  async split(paneId: string, direction: "right" | "down"): Promise<{ id: string }> {
    await this.assertPane(paneId);
    const response = await this.client.request(
      "pane.split",
      { target_pane_id: paneId, direction, focus: false },
      z.unknown(),
    );
    return PaneIdSchema.parse(response);
  }

  async createTab(label: string): Promise<{ id: string; tabId: string }> {
    const workspace = (await this.snapshot()).workspaces.find(
      (candidate) => candidate.id === this.config.workspaceId,
    );
    if (!workspace) throw new Error(`Workspace is outside run scope: ${this.config.workspaceId}`);
    const response = await this.client.request(
      "tab.create",
      {
        workspace_id: this.config.workspaceId,
        cwd: this.config.worktreePath,
        label,
        env: {},
        focus: false,
      },
      z.unknown(),
    );
    const created = TabCreatedSchema.parse(response);
    this.ownedTabIds.add(created.tabId);
    return created;
  }

  /** Closes a tab this instance created; refuses tabs it does not own. */
  async closeTab(tabId: string): Promise<void> {
    if (!this.ownedTabIds.has(tabId)) {
      throw new Error(`Tab is outside run scope: ${tabId}`);
    }
    await this.client.request("tab.close", { tab_id: tabId }, AcceptedSchema);
    this.ownedTabIds.delete(tabId);
  }

  async launch(input: {
    paneId: string;
    name: string;
    kind?: string;
    command: string;
    args: string[];
    interactive?: boolean;
  }): Promise<{ id?: string }> {
    await this.assertPane(input.paneId);
    this.assertAgentName(input.name);
    if (input.interactive) {
      await this.client.request(
        "pane.send_input",
        { pane_id: input.paneId, text: shellCommand(input.command, input.args), keys: ["Enter"] },
        AcceptedSchema,
      );
      return {};
    }
    const response = await this.client.request(
      "agent.start",
      {
        pane_id: input.paneId,
        name: input.name,
        kind: input.kind,
        args: input.args,
      },
      z.unknown(),
    );
    return AgentIdSchema.parse(response);
  }

  async rename(agentId: string, name: string): Promise<unknown> {
    await this.assertAgent(agentId, false);
    this.assertAgentName(name);
    return this.client.request("agent.rename", { target: agentId, name }, AcceptedSchema);
  }

  async prompt(agentId: string, prompt: string): Promise<unknown> {
    const agent = await this.assertAgent(agentId);
    if (agent.kind === "copilot") {
      await this.client.request(
        "pane.send_input",
        { pane_id: agent.paneId, text: prompt, keys: [] },
        AcceptedSchema,
      );
      await delay(250);
      return this.client.request(
        "pane.send_input",
        { pane_id: agent.paneId, text: "", keys: ["Enter"] },
        AcceptedSchema,
      );
    }
    return this.client.request("agent.prompt", { target: agentId, text: prompt }, AcceptedSchema);
  }

  async submitPendingInput(agentId: string): Promise<unknown> {
    const agent = await this.assertAgent(agentId);
    return this.client.request(
      "pane.send_input",
      { pane_id: agent.paneId, text: "", keys: ["Enter"] },
      AcceptedSchema,
    );
  }

  async enableCodexPlanMode(agentId: string): Promise<unknown> {
    const snapshot = await this.snapshot();
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    const pane = agent && snapshot.panes.find((candidate) => candidate.id === agent.paneId);
    if (
      !agent ||
      !pane ||
      pane.workspaceId !== this.config.workspaceId ||
      pane.exited ||
      !agent.name.startsWith(this.config.agentPrefix) ||
      agent.kind !== "codex"
    ) {
      throw new Error(`Codex agent is outside run scope or unavailable: ${agentId}`);
    }
    return this.client.request(
      "pane.send_input",
      { pane_id: pane.id, text: "/plan", keys: ["Enter"] },
      AcceptedSchema,
    );
  }

  async wait(agentId: string, states: string[], timeoutMs: number): Promise<unknown> {
    await this.assertAgent(agentId);
    return this.client.request(
      "agent.wait",
      { target: agentId, until: states, timeout_ms: timeoutMs },
      z.unknown(),
    );
  }

  async read(
    agentId: string,
    options: { source?: HerdrReadSource; lines?: number } = {},
  ): Promise<{ text: string }> {
    await this.assertAgent(agentId);
    const response = await this.client.request(
      "agent.read",
      {
        target: agentId,
        source: options.source ?? HerdrReadSource.Visible,
        lines: options.lines ?? 80,
      },
      z.unknown(),
    );
    return ReadSchema.parse(response);
  }

  async sendKeys(agentId: string, keys: string[]): Promise<unknown> {
    await this.assertAgent(agentId);
    return this.client.request("agent.send_keys", { target: agentId, keys }, AcceptedSchema);
  }

  private async assertPane(paneId: string): Promise<void> {
    const snapshot = await this.snapshot();
    const pane = snapshot.panes.find((candidate) => candidate.id === paneId);
    if (!pane || pane.workspaceId !== this.config.workspaceId || pane.exited) {
      throw new Error(`Pane is outside run scope or unavailable: ${paneId}`);
    }
  }

  private async assertAgent(
    agentId: string,
    requirePrefix = true,
  ): Promise<HerdrSnapshot["agents"][number]> {
    const snapshot = await this.snapshot();
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    const pane = agent && snapshot.panes.find((candidate) => candidate.id === agent.paneId);
    if (
      !agent ||
      !pane ||
      pane.workspaceId !== this.config.workspaceId ||
      pane.exited ||
      (requirePrefix && !agent.name.startsWith(this.config.agentPrefix))
    ) {
      throw new Error(`Agent is outside run scope: ${agentId}`);
    }
    return agent;
  }

  private assertAgentName(name: string): void {
    if (!name.startsWith(this.config.agentPrefix)) {
      throw new Error(`Agent name is outside run scope: ${name}`);
    }
  }
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args.map((part) => `'${part.replaceAll("'", `'"'"'`)}'`)].join(" ");
}

function normalizeSnapshot(value: unknown): unknown {
  const root = unwrap(value);
  const records = collectRecords(root);
  const workspaces = uniqueById(
    records
      .filter(
        (record) =>
          record.type === "workspace" ||
          (hasAny(record, "workspace_id") &&
            !hasAny(record, "pane_id", "paneId", "agent_id", "agentId")),
      )
      .map((record) => ({
        ...record,
        id: readString(record, "id", "workspace_id", "workspaceId"),
        cwd:
          readString(record, "cwd", "checkout_path", "checkoutPath") ??
          findNestedString(record.worktree, "checkout_path", "checkoutPath"),
      }))
      .filter((record) => record.id),
  );
  const panes = uniqueById(
    records
      .filter(
        (record) =>
          record.type === "pane" ||
          (record.type !== "agent" &&
            hasAny(record, "pane_id") &&
            !hasAny(record, "agent_id", "agentId")),
      )
      .map((record) => ({
        ...record,
        id: readString(record, "id", "pane_id", "paneId"),
        workspaceId: readString(record, "workspaceId", "workspace_id"),
        cwd: readString(record, "cwd"),
        exited: record.exited === true || record.status === "exited",
      }))
      .filter((record) => record.id && record.workspaceId),
  );
  const agents = uniqueById(
    records
      .filter((record) => hasAny(record, "agent_id", "agentId") || record.type === "agent")
      .map((record) => {
        const paneId = readString(record, "paneId", "pane_id");
        const id = readString(record, "agent_id", "agentId", "id") ?? paneId;
        return {
          ...record,
          id,
          name: readString(record, "name", "agent_name", "agentName", "display_agent") ?? id,
          paneId,
          kind: readString(record, "kind", "agent_kind", "agentKind", "agent"),
          status: readString(record, "status", "agent_status", "agentStatus"),
          interactiveReady: record.interactiveReady === true || record.interactive_ready === true,
        };
      })
      .filter((record) => record.id && record.name && record.paneId),
  );
  const direct = root && typeof root === "object" && !Array.isArray(root) ? root : {};
  return {
    ...direct,
    workspaces: workspaces.length > 0 ? workspaces : readArray(direct, "workspaces"),
    panes: panes.length > 0 ? panes : readArray(direct, "panes"),
    agents,
  };
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.result ?? record.snapshot ?? record.data ?? value;
}

function collectRecords(
  value: unknown,
  output: Array<Record<string, unknown>> = [],
  context: { workspaceId?: string; paneId?: string } = {},
  kindHint?: "workspace" | "pane" | "agent",
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) collectRecords(child, output, context, kindHint);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : kindHint;
    const ownId = readString(record, "id");
    const workspaceId =
      readString(record, "workspaceId", "workspace_id") ??
      (type === "workspace" ? ownId : context.workspaceId);
    const paneId =
      readString(record, "paneId", "pane_id") ?? (type === "pane" ? ownId : context.paneId);
    const decorated = {
      ...(workspaceId ? { workspaceId } : {}),
      ...(paneId ? { paneId } : {}),
      ...record,
      ...(type ? { type } : {}),
    };
    output.push(decorated);
    for (const [key, child] of Object.entries(record)) {
      const childKind =
        key === "workspaces"
          ? "workspace"
          : key === "panes"
            ? "pane"
            : key === "agents"
              ? "agent"
              : undefined;
      collectRecords(child, output, { workspaceId, paneId }, childKind);
    }
  }
  return output;
}

function hasAny(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => key in record);
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function readArray(value: object, key: string): unknown[] {
  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child : [];
}

function uniqueById(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ids = new Set<string>();
  return records.filter((record) => {
    if (typeof record.id !== "string" || ids.has(record.id)) return false;
    ids.add(record.id);
    return true;
  });
}

function findNestedString(value: unknown, ...keys: string[]): string | undefined {
  if (typeof value === "string" && keys.includes("text")) return value;
  for (const key of keys) {
    const found = findNestedStringForKey(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findNestedStringForKey(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNestedStringForKey(child, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = readString(record, key);
  if (direct !== undefined) return direct;
  for (const child of Object.values(record)) {
    const found = findNestedStringForKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readRootString(value: unknown, key: string): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? readString(value as Record<string, unknown>, key)
    : undefined;
}
