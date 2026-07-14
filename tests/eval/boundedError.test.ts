import { describe, expect, it } from "vitest";
import {
  boundedErrorText,
  formatBoundedError,
  MAX_PERSISTED_ERROR_LENGTH,
} from "../../src/eval/boundedError.js";

describe("bounded persisted errors", () => {
  it.each([
    ["PROJECT_VERIFICATION_JUDGE_API_KEY=plain-secret-value", "plain-secret-value"],
    ["COPILOT_PROXY_API_KEY:anything", "anything"],
    ["TELEGRAM_BOT_TOKEN=123456", "123456"],
    ['SERVICE_SECRET = "quoted secret value"', "quoted secret value"],
    ["Database_Password : 'mixed case password'", "mixed case password"],
    ['SIGNING_PRIVATE_KEY = "private material"', "private material"],
    ["GitHub_Access_Token:'access token material'", "access token material"],
  ])("redacts environment credential assignment %s", (assignment, secret) => {
    const key = assignment.match(/^[A-Za-z0-9_]+/)?.[0];
    const result = boundedErrorText(`command failed: ${assignment}; retry disabled`);

    expect(result).toContain(`command failed: ${key}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(secret);
    expect(result).toContain("retry disabled");
  });

  it("preserves benign assignment-like words", () => {
    const message =
      "monkey=banana token_budget=123 passwordPolicy=strong secretariat=public public_key=docs";

    expect(boundedErrorText(message)).toBe(message);
  });

  it("keeps existing bearer, short credential, and sk redaction bounded", () => {
    const result = formatBoundedError(
      "provider failed",
      `Authorization: Bearer bearer-value api_key=api-value token=token-value secret=secret-value password=password-value sk-project-1234567890 ${"x".repeat(2_000)}`,
    );

    expect(result).toMatch(/^provider failed:/);
    expect(result.length).toBeLessThanOrEqual(MAX_PERSISTED_ERROR_LENGTH);
    for (const secret of [
      "bearer-value",
      "api-value",
      "token-value",
      "secret-value",
      "password-value",
      "sk-project-1234567890",
    ]) {
      expect(result).not.toContain(secret);
    }
  });
});
