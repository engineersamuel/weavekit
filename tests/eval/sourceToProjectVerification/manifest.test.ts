import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectVerificationManifest,
  parseProjectVerificationManifest,
  verifyProjectVerificationManifest,
} from "../../../src/eval/sourceToProjectVerification/manifest.js";

describe("source-to-project plan artifact manifest", () => {
  it("freezes one canonical artifact per provider with a digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-plan-manifest-"));
    const planPath = join(root, "plan.md");
    await writeFile(planPath, "# plan\n", "utf8");

    const manifest = await buildProjectVerificationManifest({
      caseId: "todo-safe-write",
      caseSha256: "a".repeat(64),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-1",
      rows: [
        {
          provider: { id: "weavekit:source-to-project" },
          success: true,
          latencyMs: 123,
          tokenUsage: { prompt: 100, completion: 25, total: 125 },
          cost: 0.42,
          response: {
            output: "# plan\n",
            metadata: {
              artifactPaths: [planPath],
              workspaceMutationVerified: true,
              model: "gpt-5.5",
              retries: 2,
            },
          },
        },
      ],
    });

    expect(manifest).toMatchObject({
      version: 2,
      promptfooGenerationEvaluationId: "eval-generation-1",
    });
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({
        providerId: "weavekit:source-to-project",
        planPath,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        generationSucceeded: true,
        workspaceMutationVerified: true,
        model: "gpt-5.5",
        latencyMs: 123,
        tokenUsage: { prompt: 100, completion: 25, total: 125 },
        estimatedCostUsd: 0.42,
        retries: 2,
      }),
    ]);
    await expect(verifyProjectVerificationManifest(manifest, root)).resolves.toEqual([
      { providerId: "weavekit:source-to-project", markdown: "# plan\n" },
    ]);
  });

  it("normalizes Promptfoo token usage to finite nonnegative counters", async () => {
    const manifest = await buildProjectVerificationManifest({
      caseId: "todo-safe-write",
      caseSha256: "e".repeat(64),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-token-usage",
      rows: [
        {
          provider: { id: "copilot-cli:plan" },
          success: false,
          tokenUsage: {
            prompt: 100,
            completion: 25,
            cached: 10,
            total: 125,
            numRequests: 1,
            completionDetails: { reasoning: 20 },
            assertions: { prompt: 4, completion: 2 },
            negative: -1,
            infinite: Number.POSITIVE_INFINITY,
          },
        },
      ],
    });

    expect(manifest.artifacts[0]?.tokenUsage).toEqual({
      prompt: 100,
      completion: 25,
      cached: 10,
      total: 125,
      numRequests: 1,
    });
  });

  it("fails closed when a frozen plan changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-plan-manifest-mismatch-"));
    const planPath = join(root, "plan.md");
    await writeFile(planPath, "# original\n", "utf8");
    const manifest = await buildProjectVerificationManifest({
      caseId: "todo-safe-write",
      caseSha256: "b".repeat(64),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-2",
      rows: [
        {
          provider: { id: "codex-cli:plan" },
          success: true,
          response: {
            output: "# original\n",
            metadata: { artifactPaths: [planPath], workspaceMutationVerified: true },
          },
        },
      ],
    });
    await writeFile(planPath, "# changed\n", "utf8");

    await expect(verifyProjectVerificationManifest(manifest, root)).rejects.toThrow(
      /digest mismatch.*codex-cli:plan/i,
    );
  });

  it("records generation failure without inventing a quality artifact", async () => {
    const manifest = await buildProjectVerificationManifest({
      caseId: "todo-safe-write",
      caseSha256: "c".repeat(64),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-3",
      rows: [
        {
          provider: { id: "copilot-cli:plan" },
          success: false,
          error: "provider timed out",
        },
      ],
    });

    expect(manifest.artifacts[0]).toMatchObject({
      providerId: "copilot-cli:plan",
      generationSucceeded: false,
      workspaceMutationVerified: false,
      errors: ["provider timed out"],
    });
    expect(manifest.artifacts[0]).not.toHaveProperty("planPath");
  });

  it("redacts and bounds provider and workspace errors at the manifest freeze boundary", async () => {
    const secrets = [
      "bearer-manifest-secret",
      "api-key-manifest-secret",
      "token-manifest-secret",
      "named-manifest-secret",
      "password-manifest-secret",
      "sk-project-manifest-secret-123456",
      "environment-api-key-secret",
      "environment-bot-token-secret",
      "environment-private-key-secret",
      "environment-access-token-secret",
    ];
    const longSuffix = ` stdout=${"o".repeat(2_000)} stderr=${"e".repeat(2_000)}`;
    const manifest = await buildProjectVerificationManifest({
      caseId: "todo-safe-write",
      caseSha256: "f".repeat(64),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-redacted-errors",
      rows: [
        {
          provider: { id: "copilot-cli:plan" },
          success: false,
          error: `Copilot plan provider failed: Authorization: Bearer ${secrets[0]} api_key=${secrets[1]} token=${secrets[2]} secret=${secrets[3]} password=${secrets[4]} ${secrets[5]} PROJECT_VERIFICATION_JUDGE_API_KEY=${secrets[6]} TELEGRAM_BOT_TOKEN : "${secrets[7]}" SIGNING_PRIVATE_KEY='${secrets[8]}' GitHub_Access_Token=${secrets[9]}${longSuffix}`,
          response: {
            metadata: {
              workspaceMutationVerified: false,
              workspaceMutationError: `Provider modified app.ts token=${secrets[2]}${longSuffix}`,
            },
          },
        },
      ],
    });

    expect(manifest.artifacts[0]?.errors).toHaveLength(2);
    for (const error of manifest.artifacts[0]?.errors ?? []) {
      expect(error.length).toBeLessThanOrEqual(1_024);
      for (const secret of secrets) expect(error).not.toContain(secret);
    }
    expect(manifest.artifacts[0]?.errors[0]).toMatch(/^Copilot plan provider failed:/);
    expect(manifest.artifacts[0]?.errors[1]).toMatch(/^Provider modified app\.ts/);
  });

  it("keeps successful generation separate from failed mutation safety", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-mutated-plan-manifest-"));
    const planPath = join(root, "plan.md");
    await writeFile(planPath, "# generated\n", "utf8");

    const manifest = await buildProjectVerificationManifest({
      caseId: "todo-safe-write",
      caseSha256: "d".repeat(64),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-4",
      rows: [
        {
          provider: { id: "copilot-cli:plan" },
          success: true,
          response: {
            output: "# generated\n",
            metadata: {
              artifactPaths: [planPath],
              workspaceMutationVerified: false,
              workspaceMutationError: "Provider modified app.ts.",
            },
          },
        },
      ],
    });

    expect(manifest.artifacts[0]).toMatchObject({
      generationSucceeded: true,
      workspaceMutationVerified: false,
      errors: ["Provider modified app.ts."],
    });
  });

  it.each([
    ["provider id", (artifact: Record<string, unknown>) => (artifact.providerId = 42)],
    [
      "generation status",
      (artifact: Record<string, unknown>) => (artifact.generationSucceeded = "yes"),
    ],
    [
      "workspace mutation status",
      (artifact: Record<string, unknown>) => (artifact.workspaceMutationVerified = 1),
    ],
    ["plan path", (artifact: Record<string, unknown>) => (artifact.planPath = 42)],
    [
      "missing successful plan path",
      (artifact: Record<string, unknown>) => delete artifact.planPath,
    ],
    ["digest", (artifact: Record<string, unknown>) => (artifact.sha256 = "not-a-digest")],
    ["missing successful digest", (artifact: Record<string, unknown>) => delete artifact.sha256],
    ["model", (artifact: Record<string, unknown>) => (artifact.model = 42)],
    ["latency", (artifact: Record<string, unknown>) => (artifact.latencyMs = -1)],
    ["token usage", (artifact: Record<string, unknown>) => (artifact.tokenUsage = { total: -1 })],
    ["estimated cost", (artifact: Record<string, unknown>) => (artifact.estimatedCostUsd = -1)],
    ["retries", (artifact: Record<string, unknown>) => (artifact.retries = 1.5)],
    [
      "opportunity diagnostics",
      (artifact: Record<string, unknown>) => (artifact.opportunityDiagnostics = { bundles: "bad" }),
    ],
    ["errors", (artifact: Record<string, unknown>) => (artifact.errors = "none")],
  ])("rejects a manifest with malformed artifact %s", (_label, mutate) => {
    const value = validSerializedManifest();
    mutate(value.artifacts[0]!);

    expect(() => parseProjectVerificationManifest(value)).toThrow(/manifest/i);
  });

  it.each([
    ["case id", (manifest: Record<string, unknown>) => (manifest.caseId = "")],
    ["case digest", (manifest: Record<string, unknown>) => (manifest.caseSha256 = "bad")],
    ["created at", (manifest: Record<string, unknown>) => (manifest.createdAt = 42)],
    [
      "generation evaluation id",
      (manifest: Record<string, unknown>) => (manifest.promptfooGenerationEvaluationId = ""),
    ],
  ])("rejects a manifest with malformed top-level %s", (_label, mutate) => {
    const value = validSerializedManifest() as unknown as Record<string, unknown>;
    mutate(value);

    expect(() => parseProjectVerificationManifest(value)).toThrow(/manifest/i);
  });
});

function validSerializedManifest(): {
  artifacts: Array<Record<string, unknown>>;
} & Record<string, unknown> {
  return {
    version: 2,
    caseId: "todo-safe-write",
    caseSha256: "a".repeat(64),
    createdAt: "2026-07-10T12:00:00.000Z",
    promptfooGenerationEvaluationId: "eval-generation-1",
    artifacts: [
      {
        providerId: "weavekit:source-to-project",
        generationSucceeded: true,
        workspaceMutationVerified: true,
        planPath: "/tmp/plan.md",
        sha256: "b".repeat(64),
        model: "gpt-5.5",
        latencyMs: 1,
        tokenUsage: { prompt: 1, completion: 1, cached: 0, total: 2 },
        estimatedCostUsd: 0.1,
        retries: 0,
        errors: [],
      },
    ],
  };
}
