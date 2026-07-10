export const OBJECTIVE_PREVIEW_LENGTH = 220;

export function getObjectivePreview(objective: unknown): string {
  const text = String(objective ?? "").trim();
  if (text.length <= OBJECTIVE_PREVIEW_LENGTH) {
    return text;
  }
  return `${text.slice(0, OBJECTIVE_PREVIEW_LENGTH - 3).trimEnd()}...`;
}

export function shouldShowObjectiveExpansion(objective: unknown): boolean {
  return String(objective ?? "").trim().length > OBJECTIVE_PREVIEW_LENGTH;
}
