export const MAX_PERSISTED_ERROR_LENGTH = 1_024;

export function formatBoundedError(context: string, error: unknown): string {
  return boundedErrorText(`${context}: ${errorText(error)}`);
}

export function boundedErrorText(error: unknown): string {
  const redacted = redactSecrets(errorText(error));
  if (redacted.length <= MAX_PERSISTED_ERROR_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_PERSISTED_ERROR_LENGTH - 3)}...`;
}

export function sanitizePersistedErrorFields<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (isErrorField(key)) return sanitizeErrorField(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeValue(entryValue, entryKey),
    ]),
  );
}

function sanitizeErrorField(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => boundedErrorText(item));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  return boundedErrorText(value);
}

function isErrorField(key: string | undefined): boolean {
  return Boolean(
    key &&
    /^(?:error|errors|failure|failureReason|reason|stderr|stdout|workspaceMutationError)$/i.test(
      key,
    ),
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown failure";
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return String(error);
  }
  return "Unknown failure";
}

function redactSecrets(message: string): string {
  return message
    .replace(
      /(\bauthorization\s*:\s*bearer\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:[A-Za-z][A-Za-z0-9_]*_)?(?:api[_-]?key|access_token|private_key|token|secret|password)|key)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g, "[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
