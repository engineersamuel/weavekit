import { describe, expect, it } from "vitest";
import {
  MastermindAction,
  ProjectRepositoryMode,
  RepositoryEvidenceType,
  ReviewEvidenceKind,
  TicketKind,
  type TicketReviewDossier,
} from "../../src/generated/baml_client/index.js";
import {
  CopilotSdkTicketReviewHarness,
  createReviewPermissionHandler,
  extractJsonObject,
  parseTicketReviewDossier,
} from "../../src/mastermind/review/harness.js";
import { unknownCopilotToolNames } from "../../src/mastermind/harness/toolNames.js";
import { resolveReviewSkillDiscoveryDirectory } from "../../src/mastermind/review/skillDirectory.js";

const dossier: TicketReviewDossier = {
  ticketKind: TicketKind.TECHNICAL_TASK,
  preservedIntent: "Clarify a ticket without changing its scope.",
  summary: "Repository evidence supports implementation.",
  repositoryEvidence: [
    {
      id: "repo-package",
      kind: ReviewEvidenceKind.REPOSITORY,
      repositoryEvidenceType: RepositoryEvidenceType.FILE,
      repositoryPath: "package.json",
      claim: "The repository defines its validation scripts.",
      confidence: 1,
    },
  ],
  linearEvidence: [],
  externalEvidence: [],
  assumptions: [],
  ambiguities: [],
  unansweredQuestions: [],
  risks: [],
  dependencies: [],
  suggestedAcceptanceCriteria: ["The ticket contains observable acceptance criteria."],
  automatedVerification: ["nub run test"],
  manualVerification: [],
  validationSteps: ["Confirm the ticket describes the intended outcome."],
  observability: [],
  rolloutPlan: [],
  rollbackPlan: [],
  outOfScope: [],
  materialScopeChange: false,
  confidence: 0.95,
};
const reviewSkillsDirectory = `${process.cwd()}/.github/skills`;

describe("Copilot SDK ticket review harness", () => {
  it("infers an omitted evidence kind from its typed evidence array", () => {
    const raw = structuredClone(dossier) as unknown as Record<string, unknown>;
    raw.linearEvidence = [
      {
        id: "linear-ticket",
        locator: "WK-1",
        claim: "The ticket defines the objective.",
        confidence: 1,
      },
    ];

    expect(parseTicketReviewDossier(JSON.stringify(raw)).linearEvidence).toEqual([
      {
        id: "linear-ticket",
        kind: ReviewEvidenceKind.LINEAR,
        locator: "WK-1",
        claim: "The ticket defines the objective.",
        confidence: 1,
      },
    ]);
  });

  it("moves shell preflight observations out of HTTPS-only external evidence", () => {
    const raw = structuredClone(dossier) as unknown as Record<string, unknown>;
    raw.externalEvidence = [
      {
        id: "auth-check",
        kind: ReviewEvidenceKind.EXTERNAL,
        locator: "shell: gh auth status (2026-08-13)",
        claim: "GitHub CLI authentication succeeded.",
        confidence: 1,
      },
    ];

    const parsed = parseTicketReviewDossier(JSON.stringify(raw));

    expect(parsed.externalEvidence).toEqual([]);
    expect(parsed.assumptions).toContain(
      "Executor preflight observation (shell: gh auth status (2026-08-13)): GitHub CLI authentication succeeded.",
    );
  });

  it("loads the review skill with an explicit read-only tool allowlist", async () => {
    let sessionConfig: unknown;
    let readPermission: unknown;
    let urlPermission: unknown;
    let writePermission: unknown;
    let disconnected = false;
    let stopped = false;
    const harness = new CopilotSdkTicketReviewHarness({
      clientFactory: () => ({
        async start() {},
        async createSession(config) {
          sessionConfig = config;
          if (!config || typeof config !== "object") {
            throw new Error("Expected Copilot session configuration.");
          }
          const permissionHandler = Reflect.get(config, "onPermissionRequest");
          if (typeof permissionHandler !== "function") {
            throw new Error("Expected a permission handler.");
          }
          readPermission = permissionHandler({ kind: "read" });
          urlPermission = permissionHandler({
            kind: "url",
            url: "https://example.com/research",
            toolCallId: "call-url",
          });
          writePermission = permissionHandler({
            kind: "shell",
            hasWriteFileRedirection: true,
            requestSandboxBypass: false,
            commands: [{ readOnly: false }],
          });
          return {
            async sendAndWait() {
              return { data: { content: JSON.stringify(dossier) } };
            },
            async disconnect() {
              disconnected = true;
            },
          };
        },
        async stop() {
          stopped = true;
          return undefined;
        },
      }),
      skillsDirectory: reviewSkillsDirectory,
    });

    await expect(
      harness.review({
        ticket: {
          id: "issue-one",
          identifier: "WK-1",
          title: "Clarify ticket",
          description: "Review this ticket.",
          labels: [],
          status: "Todo",
          projectId: "project-one",
          teamId: "team-one",
        },
        project: {
          id: "weavekit",
          displayName: "Weavekit",
          repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
          repositoryPath: process.cwd(),
          allowedActions: [MastermindAction.REVIEW_TICKET],
        },
      }),
    ).resolves.toEqual(dossier);

    expect(sessionConfig).toMatchObject({
      streaming: false,
      skillDirectories: [reviewSkillsDirectory],
      availableTools: ["view", "grep", "rg", "glob", "skill", "bash"],
      onPermissionRequest: expect.any(Function),
    });
    // An availableTools entry naming no registered tool is dropped silently, so a typo removes a
    // capability without any error. Fail here instead.
    expect(
      unknownCopilotToolNames((sessionConfig as { availableTools: string[] }).availableTools),
    ).toEqual([]);
    expect(disconnected).toBe(true);
    expect(stopped).toBe(true);
    expect(readPermission).toEqual({ kind: "approve-once" });
    expect(urlPermission).toMatchObject({ kind: "reject" });
    expect(writePermission).toMatchObject({ kind: "reject" });
  });

  it("reviews greenfield projects without repository tools or creating a project directory", async () => {
    let workingDirectory: string | undefined;
    let sessionConfig: unknown;
    const harness = new CopilotSdkTicketReviewHarness({
      clientFactory: (directory) => {
        workingDirectory = directory;
        return {
          async start() {},
          async createSession(config) {
            sessionConfig = config;
            return {
              async sendAndWait() {
                return {
                  data: {
                    content: JSON.stringify({
                      ...dossier,
                      summary: "No repository exists yet.",
                      repositoryEvidence: [],
                    }),
                  },
                };
              },
              async disconnect() {},
            };
          },
          async stop() {
            return undefined;
          },
        };
      },
    });

    await harness.review({
      ticket: {
        id: "issue-prototype",
        identifier: "ENG-5",
        title: "Build a prototype",
        description: "Create a greenfield prototype.",
        labels: [],
        status: "Todo",
        projectId: "project-prototypes",
        teamId: "team-one",
      },
      project: {
        id: "prototypes",
        displayName: "Prototypes",
        repositoryMode: ProjectRepositoryMode.GREENFIELD,
        provisioningRoot: "/Users/example/projects/prototypes",
        allowedActions: [MastermindAction.REVIEW_TICKET],
      },
    });

    expect(workingDirectory).toBe("/Users/example/projects/prototypes");
    expect(sessionConfig).toMatchObject({
      workingDirectory: "/Users/example/projects/prototypes",
      availableTools: ["web_fetch", "skill", "bash"],
    });
    expect(
      unknownCopilotToolNames((sessionConfig as { availableTools: string[] }).availableTools),
    ).toEqual([]);
  });

  it("approves only absolute HTTPS web_fetch URLs without embedded credentials", () => {
    const events: unknown[] = [];
    const handler = createReviewPermissionHandler({
      mode: "greenfield",
      onPermissionTelemetry: (validation) => events.push(validation),
    });

    expect(
      handler({
        kind: "url",
        url: "https://example.com/docs?q=private#fragment",
        toolCallId: "call-valid",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toEqual({ kind: "approve-once" });
    expect(
      handler({
        kind: "url",
        url: "this is not a URL",
        toolCallId: "call-invalid",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({ kind: "reject" });
    expect(
      handler({
        kind: "url",
        url: "http://example.com",
        toolCallId: "call-http",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({ kind: "reject" });
    expect(
      handler({
        kind: "url",
        url: "file:///private/tmp.txt",
        toolCallId: "call-file",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({ kind: "reject" });
    expect(
      handler({
        kind: "url",
        url: "https://",
        toolCallId: "call-missing-host",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({ kind: "reject" });
    expect(
      handler({
        kind: "url",
        url: "https://user:pass@example.com/private",
        toolCallId: "call-creds",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({ kind: "reject" });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accepted: true,
          reason: "valid",
        }),
        expect.objectContaining({
          accepted: false,
          reason: "invalid_url",
        }),
        expect.objectContaining({
          accepted: false,
          reason: "unsupported_scheme",
        }),
        expect.objectContaining({
          accepted: false,
          reason: "missing_host",
        }),
        expect.objectContaining({
          accepted: false,
          reason: "embedded_credentials",
        }),
      ]),
    );
  });

  it("emits safe telemetry for invalid then corrected web_fetch attempts", () => {
    const events: unknown[] = [];
    const handler = createReviewPermissionHandler({
      mode: "greenfield",
      onPermissionTelemetry: (validation) => events.push(validation.metadata),
    });

    expect(
      handler({
        kind: "url",
        url: "bad url",
        toolCallId: "call-one",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({ kind: "reject" });
    expect(
      handler({
        kind: "url",
        url: "https://example.com/fixed",
        toolCallId: "call-two",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toEqual({ kind: "approve-once" });

    expect(events).toEqual([
      expect.objectContaining({
        decision: "rejected",
        reason: "invalid_url",
        toolCallId: "call-one",
      }),
      expect.objectContaining({
        decision: "approved",
        reason: "valid",
        toolCallId: "call-two",
      }),
    ]);
  });

  it("rejects URL permission requests when web_fetch is disabled for repository reviews", () => {
    const events: unknown[] = [];
    const handler = createReviewPermissionHandler({
      mode: "repository",
      onPermissionTelemetry: (validation) => events.push(validation),
    });

    expect(
      handler({
        kind: "url",
        url: "https://example.com/research",
        toolCallId: "call-repository-url",
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toMatchObject({
      kind: "reject",
      feedback: "Repository-backed reviews cannot fetch external URLs in the same agent session.",
    });
    expect(events).toEqual([]);
  });

  it("approves pwd when the SDK does not classify it as read-only", () => {
    const handler = createReviewPermissionHandler({ mode: "repository" });

    expect(
      handler({
        kind: "shell",
        hasWriteFileRedirection: false,
        requestSandboxBypass: false,
        commands: [{ identifier: "pwd", readOnly: false }],
      } as Parameters<ReturnType<typeof createReviewPermissionHandler>>[0]),
    ).toEqual({ kind: "approve-once" });
  });

  it("prefers the packaged dist skill directory when it exists", () => {
    const pathExists = (path: string) =>
      path === "/repo/dist/.github/skills/weavekit-ticket-review/SKILL.md" ||
      path === "/repo/.github/skills/weavekit-ticket-review/SKILL.md";

    expect(
      resolveReviewSkillDiscoveryDirectory({
        moduleUrl: "file:///repo/dist/src/mastermind/review/harness.js",
        pathExists,
      }),
    ).toBe("/repo/dist/.github/skills");
  });

  it("falls back from dist to the repository skill directory when the packaged copy is absent", () => {
    const pathExists = (path: string) =>
      path === "/repo/.github/skills/weavekit-ticket-review/SKILL.md";

    expect(
      resolveReviewSkillDiscoveryDirectory({
        moduleUrl: "file:///repo/dist/src/mastermind/review/harness.js",
        pathExists,
      }),
    ).toBe("/repo/.github/skills");
  });

  it("throws an actionable error when the configured skill directory is missing the review skill", () => {
    expect(() =>
      resolveReviewSkillDiscoveryDirectory({
        skillsDirectory: "/repo/dist/.github/skills",
        pathExists: () => false,
      }),
    ).toThrow(
      /Mastermind review skill weavekit-ticket-review was not found in the configured skill directory\./,
    );
  });
});

describe("extractJsonObject", () => {
  it("skips a narrated shell fence and returns the json fence", () => {
    const content = [
      "I will inspect the workspace.",
      "",
      "```bash",
      "cd /tmp && ls",
      "```",
      "",
      "```json",
      '{"verdict":"PASS"}',
      "```",
    ].join("\n");
    expect(JSON.parse(extractJsonObject(content))).toEqual({ verdict: "PASS" });
  });

  it("accepts an unlabelled fence", () => {
    const content = ["```", '{"verdict":"PASS"}', "```"].join("\n");
    expect(JSON.parse(extractJsonObject(content))).toEqual({ verdict: "PASS" });
  });

  it("keeps a json fence whose string fields contain their own code fences", () => {
    const dossier = {
      summary: "Reviewed the attempt.",
      manualVerification: ["Run:\n```bash\ncd /tmp && ls\n```\nExpect exit 0."],
      confidence: 0.8,
    };
    const content = `Dossier:\n\n\`\`\`json\n${JSON.stringify(dossier, null, 2)}\n\`\`\``;
    expect(JSON.parse(extractJsonObject(content))).toEqual(dossier);
  });

  it("falls back to a brace slice when no fence is present", () => {
    expect(JSON.parse(extractJsonObject('Result: {"verdict":"PASS"} done'))).toEqual({
      verdict: "PASS",
    });
  });

  it("throws when no json object is present", () => {
    expect(() => extractJsonObject("no payload here")).toThrow(
      "Harness did not return a JSON object.",
    );
  });
});
