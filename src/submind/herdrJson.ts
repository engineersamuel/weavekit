export function parseHerdrEnvelope(output: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${operation} returned a non-object JSON envelope.`);
  }
  const envelope = parsed as Record<string, unknown>;
  const result = envelope.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${operation} did not return a result object.`);
  }
  return result as Record<string, unknown>;
}

export function findHerdrString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHerdrString(item, ...keys);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key];
    }
  }
  for (const child of Object.values(record)) {
    const found = findHerdrString(child, ...keys);
    if (found) return found;
  }
  return undefined;
}

export function findWorkspaceRootPaneId(
  value: unknown,
  workspaceId: string,
  tabId?: string,
): string | undefined {
  const result =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const panes = Array.isArray(result.panes) ? result.panes : [];
  const matches = panes.filter((pane) => {
    const record =
      pane && typeof pane === "object" && !Array.isArray(pane)
        ? (pane as Record<string, unknown>)
        : {};
    return record.workspace_id === workspaceId && (tabId === undefined || record.tab_id === tabId);
  });
  return matches.length === 1 ? findHerdrString(matches[0], "pane_id") : undefined;
}
