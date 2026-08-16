import { describe, expect, it, vi } from "vitest";
import { createRlmExecutionBudget } from "../../src/rlm-poc/budget.js";
import {
  RlmDepthExceededError,
  RlmPreparedFilesystemAccess,
  RlmProfileAuthority,
  RlmProfilePurpose,
  RlmSkillPolicyError,
  RlmUnknownProfileError,
  type RlmToolArgs,
} from "../../src/rlm-poc/contracts.js";
import { createRlmProfileRegistry, defaultRlmProfileRegistry } from "../../src/rlm-poc/profiles.js";
import {
  computeRlmSessionTimeoutMs,
  createRlmProfilePermissionHandler,
  executeRlm,
  prepareRlmSkillPolicy,
  type RlmClient,
  type RlmClientFactoryContext,
  type RlmSession,
} from "../../src/rlm-poc/session.js";

const profiles = createRlmProfileRegistry({
  default: {
    name: "default",
    description: "Test profile.",
    purpose: RlmProfilePurpose.Submind,
    authority: RlmProfileAuthority.Implementation,
    repositoryWritePermission: true,
    model: "test-model",
    reasoningEffort: "medium",
    systemMessagePrompt: "Answer directly.",
    availableTools: ["skill"],
  },
});

function fakeSession(content: string): RlmSession {
  return {
    async sendAndWait() {
      return { data: { content } };
    },
    async disconnect() {},
  };
}

function fakeClient(session: RlmSession): {
  client: RlmClient;
  createSessionConfigs: Record<string, unknown>[];
  disconnected: boolean;
  stopped: boolean;
} {
  const createSessionConfigs: Record<string, unknown>[] = [];
  let disconnected = false;
  let stopped = false;
  const client: RlmClient = {
    async start() {},
    async createSession(config) {
      createSessionConfigs.push(config);
      const wrapped: RlmSession = {
        ...session,
        rpc: session.rpc ?? {
          skills: {
            async ensureLoaded() {},
            async list() {
              return { skills: [] };
            },
          },
        },
        async disconnect() {
          disconnected = true;
          await session.disconnect();
        },
      };
      return wrapped;
    },
    rpc: {
      skills: {
        async discover() {
          return { skills: [] };
        },
      },
    },
    async stop() {
      stopped = true;
    },
  };
  return {
    client,
    createSessionConfigs,
    get disconnected() {
      return disconnected;
    },
    get stopped() {
      return stopped;
    },
  };
}

const args: RlmToolArgs = { prompt: "What is your favorite color?", profile: "default" };
const noPreparedSkills = async () => undefined;

describe("executeRlm", () => {
  it("fails closed with RlmDepthExceededError without creating a client when depth is exhausted", async () => {
    const clientFactory = vi.fn();
    await expect(
      executeRlm({
        args,
        depthRemaining: 0,
        maxDepth: 3,
        profiles,
        clientFactory,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
      }),
    ).rejects.toThrow(RlmDepthExceededError);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("throws RlmUnknownProfileError without creating a client for an unresolvable profile", async () => {
    const clientFactory = vi.fn();
    await expect(
      executeRlm({
        args: { ...args, profile: "does-not-exist" },
        depthRemaining: 2,
        maxDepth: 3,
        profiles,
        clientFactory,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
      }),
    ).rejects.toThrow(RlmUnknownProfileError);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("creates a clean-slate session with the resolved profile, decrements depth, and returns the response text", async () => {
    const fake = fakeClient(fakeSession("Blue."));
    const { client, createSessionConfigs } = fake;
    const buildNestedTool = vi.fn().mockReturnValue({ name: "rlm-nested-stub" });
    const onPermissionRequest = () => ({ kind: "approve-once" as const });

    const result = await executeRlm({
      args,
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      prepareProfileSkills: noPreparedSkills,
      clientFactory: () => client,
      buildNestedTool,
      onPermissionRequest,
    });

    expect(result).toEqual({
      text: "Blue.",
      depthUsed: 1,
      model: "test-model",
      modelRationale: "Profile uses configured model test-model.",
      budget: { maxCalls: 12, usedCalls: 1, remainingCalls: 11 },
    });

    // Depth is threaded/decremented by the tool implementation, never exposed to the LLM.
    expect(buildNestedTool).toHaveBeenCalledWith(2, undefined, undefined);

    expect(createSessionConfigs).toHaveLength(1);
    const config = createSessionConfigs[0]!;
    expect(config.model).toBe("test-model");
    expect(config.reasoningEffort).toBe("medium");
    expect(config.enableConfigDiscovery).toBe(true);
    expect(config.enableSkills).toBe(false);
    expect(config.memory).toEqual({ enabled: false });
    const systemMessage = config.systemMessage as { content: string };
    expect(systemMessage.content).toContain("Answer directly.");
    expect(systemMessage.content).toContain("# Worker Execution Envelope");
    expect(systemMessage.content).toContain("Profile: default");
    expect(systemMessage.content).toContain("Authority: implementation");
    expect(systemMessage.content).toContain("Repository write permission: allowed");
    expect(systemMessage.content).toContain("Remaining recursion depth: 2");
    expect(systemMessage.content).toContain("Remaining call budget: 11/12");
    expect(config.availableTools).toEqual(["skill"]);
    expect(config.tools).toEqual([{ name: "rlm-nested-stub" }]);
    expect(config.onPermissionRequest).toBe(onPermissionRequest);

    expect(fake.disconnected).toBe(true);
    expect(fake.stopped).toBe(true);
  });

  it("does not expose a nested rlm tool after recursion depth is exhausted", async () => {
    const fake = fakeClient(fakeSession("Blue."));
    const buildNestedTool = vi.fn().mockReturnValue({ name: "rlm-nested-stub" });

    await executeRlm({
      args,
      depthRemaining: 1,
      maxDepth: 1,
      profiles,
      prepareProfileSkills: noPreparedSkills,
      clientFactory: () => fake.client,
      buildNestedTool,
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });

    expect(buildNestedTool).not.toHaveBeenCalled();
    expect(fake.createSessionConfigs[0]?.tools).toEqual([]);
  });

  it("prepares and scopes a skill bundle only to the selected child session", async () => {
    const skilledProfiles = createRlmProfileRegistry({
      skilled: {
        name: "skilled",
        description: "Skilled test profile.",
        purpose: RlmProfilePurpose.Execution,
        authority: RlmProfileAuthority.Implementation,
        repositoryWritePermission: true,
        model: "test-model",
        systemMessagePrompt: "Use the loaded skill.",
        skillBundle: "superpowers",
        sendTimeoutMs: 90_000,
        allowedChildProfiles: [],
      },
    });
    let receivedTimeout: number | undefined;
    const fake = fakeClient({
      rpc: {
        skills: {
          async ensureLoaded() {},
          async list() {
            return {
              skills: [
                {
                  name: "rlm-handoff",
                  source: "custom",
                  enabled: true,
                  path: "/cache/superpowers/skills/rlm-handoff/SKILL.md",
                },
                {
                  name: "better-github-skill",
                  source: "custom",
                  enabled: true,
                  path: "/cache/superpowers/skills/better-github-skill/SKILL.md",
                },
              ],
            };
          },
        },
      },
      async sendAndWait(_options, timeout) {
        receivedTimeout = timeout;
        return { data: { content: "Done." } };
      },
      async disconnect() {},
    });
    const prepareProfileSkills = vi.fn().mockResolvedValue({
      skillDirectories: ["/cache/superpowers/skills"],
      environment: { PATH: "/cache/bin" },
      workingDirectory: "/cache/workspaces/skilled",
    });
    if (!fake.client.rpc) throw new Error("Expected fake skill discovery RPC.");
    fake.client.rpc.skills.discover = async () => ({
      skills: [
        {
          name: "rlm-handoff",
          source: "custom",
          enabled: true,
          path: "/cache/superpowers/skills/rlm-handoff/SKILL.md",
        },
        {
          name: "better-github-skill",
          source: "custom",
          enabled: true,
          path: "/cache/superpowers/skills/better-github-skill/SKILL.md",
        },
      ],
    });
    let clientContext: RlmClientFactoryContext | undefined;

    await executeRlm({
      args: { prompt: "Do disciplined work.", profile: "skilled" },
      depthRemaining: 2,
      maxDepth: 2,
      profiles: skilledProfiles,
      prepareProfileSkills,
      clientFactory: (context) => {
        clientContext = context;
        return fake.client;
      },
      buildNestedTool: () => ({}),
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });

    expect(prepareProfileSkills).toHaveBeenCalledWith(skilledProfiles.resolve("skilled"));
    expect(fake.createSessionConfigs[0]).toMatchObject({
      enableConfigDiscovery: true,
      enableSkills: true,
      skillDirectories: ["/cache/superpowers/skills"],
      workingDirectory: "/cache/workspaces/skilled",
    });
    expect(clientContext?.profile?.name).toBe("skilled");
    expect(clientContext?.preparedSkills?.environment).toEqual({ PATH: "/cache/bin" });
    expect(receivedTimeout).toBe(90_000);
    expect(fake.createSessionConfigs[0]?.tools).toEqual([]);
    const systemMessage = fake.createSessionConfigs[0]?.systemMessage as { content: string };
    expect(systemMessage.content).toContain("Allowed child profiles: none");
    expect(systemMessage.content).toContain(
      "you remain accountable for the correctness, integration, and verified output",
    );
  });

  it("disables discovered host skills while allowing an explicit manifest skill path", async () => {
    const policy = await prepareRlmSkillPolicy(
      {
        async start() {},
        async createSession() {
          return fakeSession("");
        },
        async stop() {},
        rpc: {
          skills: {
            async discover() {
              return {
                skills: [
                  {
                    name: "handoff",
                    source: "custom",
                    enabled: true,
                    path: "/cache/root/handoff/SKILL.md",
                  },
                  {
                    name: "better-github-skill",
                    source: "custom",
                    enabled: true,
                    path: "/cache/root/better-github-skill/SKILL.md",
                  },
                  {
                    name: "project-specialist",
                    source: "project",
                    enabled: true,
                    path: "/repo/.github/skills/project-specialist/SKILL.md",
                  },
                  {
                    name: "builtin-specialist",
                    source: "builtin",
                    enabled: true,
                  },
                ],
              };
            },
          },
        },
      },
      {
        allowedSkillNames: ["handoff", "better-github-skill"],
        allowedSkillDirectories: ["/cache/root"],
        projectPaths: ["/repo"],
      },
    );

    expect(policy.disabledSkills).toEqual(["builtin-specialist", "project-specialist"]);
    expect(policy.disabledSkills).not.toContain("handoff");
    expect(policy.disabledSkills).not.toContain("better-github-skill");
  });

  it("fails closed when an allowed skill is not discovered", async () => {
    await expect(
      prepareRlmSkillPolicy(
        {
          async start() {},
          async createSession() {
            return fakeSession("");
          },
          async stop() {},
          rpc: {
            skills: {
              async discover() {
                return { skills: [] };
              },
            },
          },
        },
        {
          allowedSkillNames: ["better-github-skill"],
          allowedSkillDirectories: ["/cache/root"],
        },
      ),
    ).rejects.toThrow("better-github-skill");
  });

  it("fails closed when allowed skills have no prepared directory", async () => {
    await expect(
      prepareRlmSkillPolicy(
        {
          async start() {},
          async createSession() {
            return fakeSession("");
          },
          async stop() {},
        },
        {
          allowedSkillNames: ["better-github-skill"],
          allowedSkillDirectories: [],
        },
      ),
    ).rejects.toThrow("at least one prepared skill directory");
  });

  it("fails closed when one allowed skill name is also discovered outside its explicit path", async () => {
    await expect(
      prepareRlmSkillPolicy(
        {
          async start() {},
          async createSession() {
            return fakeSession("");
          },
          async stop() {},
          rpc: {
            skills: {
              async discover() {
                return {
                  skills: [
                    {
                      name: "rlm-handoff",
                      source: "custom",
                      enabled: true,
                      path: "/cache/root/rlm-handoff/SKILL.md",
                    },
                    {
                      name: "handoff",
                      source: "custom",
                      enabled: true,
                      path: "/cache/root/handoff/SKILL.md",
                    },
                    {
                      name: "handoff",
                      source: "personal-copilot",
                      enabled: true,
                      path: "/home/skills/handoff/SKILL.md",
                    },
                  ],
                };
              },
            },
          },
        },
        {
          allowedSkillNames: ["handoff"],
          allowedSkillDirectories: ["/cache/root"],
        },
      ),
    ).rejects.toThrow("ambiguous name-based enablement");
  });

  it("fails closed before the worker prompt when an enabled skill is outside its manifest", async () => {
    let promptSent = false;
    let disconnected = false;
    const executionBudget = createRlmExecutionBudget(4);
    const restrictedProfiles = createRlmProfileRegistry({
      restricted: {
        name: "restricted",
        description: "Restricted skill test.",
        purpose: RlmProfilePurpose.Review,
        authority: RlmProfileAuthority.Review,
        repositoryWritePermission: false,
        model: "test-model",
        systemMessagePrompt: "Review.",
        allowedSkillNames: ["handoff"],
      },
    });
    const client: RlmClient = {
      async start() {},
      rpc: {
        skills: {
          async discover() {
            return {
              skills: [
                {
                  name: "rlm-handoff",
                  source: "custom",
                  enabled: true,
                  path: "/cache/root/rlm-handoff/SKILL.md",
                },
                {
                  name: "handoff",
                  source: "custom",
                  enabled: true,
                  path: "/cache/root/handoff/SKILL.md",
                },
                {
                  name: "better-github-skill",
                  source: "custom",
                  enabled: true,
                  path: "/cache/root/better-github-skill/SKILL.md",
                },
              ],
            };
          },
        },
      },
      async createSession() {
        return {
          rpc: {
            skills: {
              async ensureLoaded() {},
              async list() {
                return {
                  skills: [
                    {
                      name: "rlm-handoff",
                      source: "custom",
                      enabled: true,
                      path: "/cache/root/rlm-handoff/SKILL.md",
                    },
                    {
                      name: "handoff",
                      source: "custom",
                      enabled: true,
                      path: "/cache/root/handoff/SKILL.md",
                    },
                    {
                      name: "better-github-skill",
                      source: "custom",
                      enabled: true,
                      path: "/cache/root/better-github-skill/SKILL.md",
                    },
                    {
                      name: "rogue",
                      source: "project",
                      enabled: true,
                      path: "/repo/.github/skills/rogue/SKILL.md",
                    },
                  ],
                };
              },
            },
          },
          async sendAndWait() {
            promptSent = true;
            return { data: { content: "must not run" } };
          },
          async disconnect() {
            disconnected = true;
          },
        };
      },
      async stop() {},
    };

    await expect(
      executeRlm({
        args: { prompt: "Review.", profile: "restricted" },
        depthRemaining: 1,
        maxDepth: 1,
        profiles: restrictedProfiles,
        prepareProfileSkills: async () => ({ skillDirectories: ["/cache/root"] }),
        clientFactory: () => client,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
        executionBudget,
      }),
    ).rejects.toThrow(RlmSkillPolicyError);
    expect(promptSent).toBe(false);
    expect(disconnected).toBe(true);
    expect(executionBudget.usedCalls).toBe(0);
  });

  it("requires a cache-scoped working directory for a no-write profile with shell access", async () => {
    const clientFactory = vi.fn();
    const executionBudget = createRlmExecutionBudget(4);
    const restrictedProfiles = createRlmProfileRegistry({
      restricted: {
        name: "restricted",
        description: "No-write shell profile.",
        purpose: RlmProfilePurpose.Research,
        authority: RlmProfileAuthority.Investigation,
        repositoryWritePermission: false,
        model: "test-model",
        systemMessagePrompt: "Investigate.",
        availableTools: ["bash"],
      },
    });

    await expect(
      executeRlm({
        args: { prompt: "Investigate.", profile: "restricted" },
        depthRemaining: 1,
        maxDepth: 1,
        profiles: restrictedProfiles,
        prepareProfileSkills: async () => ({ skillDirectories: [] }),
        clientFactory,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
        executionBudget,
      }),
    ).rejects.toThrow("configured isolated filesystem access");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(executionBudget.usedCalls).toBe(0);
  });

  it("requires an explicit filesystem policy for no-write profiles with shell access", async () => {
    const clientFactory = vi.fn();
    const restrictedProfiles = createRlmProfileRegistry({
      restricted: {
        name: "restricted",
        description: "Misconfigured no-write shell profile.",
        purpose: RlmProfilePurpose.Research,
        authority: RlmProfileAuthority.Investigation,
        repositoryWritePermission: false,
        model: "test-model",
        systemMessagePrompt: "Investigate.",
        availableTools: ["bash"],
      },
    });

    await expect(
      executeRlm({
        args: { prompt: "Investigate.", profile: "restricted" },
        depthRemaining: 1,
        maxDepth: 1,
        profiles: restrictedProfiles,
        prepareProfileSkills: async () => ({
          skillDirectories: [],
          workingDirectory: "/cache/restricted",
        }),
        clientFactory,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
      }),
    ).rejects.toThrow("configured isolated filesystem access");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("limits writable investigation profiles to their prepared working directory", async () => {
    const handler = createRlmProfilePermissionHandler(
      {
        ...defaultRlmProfileRegistry.resolve("research"),
        preparedFilesystemAccess: RlmPreparedFilesystemAccess.WorkingDirectoryWrite,
      },
      {
        skillDirectories: ["/cache/research/skills"],
        workingDirectory: "/cache/research/workspace",
      },
      () => ({ kind: "approve-once" }),
    );
    const invocation = { sessionId: "session" };

    expect(
      await handler(
        {
          kind: "write",
          canOfferSessionApproval: false,
          diff: "",
          fileName: "/cache/research/workspace/report.md",
          intention: "write report",
        },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "write",
          canOfferSessionApproval: false,
          diff: "",
          fileName: "/repo/report.md",
          intention: "write repository",
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      await handler(
        {
          kind: "shell",
          canOfferSessionApproval: false,
          commands: [{ identifier: "hyperresearch", readOnly: false }],
          fullCommandText: "hyperresearch init /repo",
          hasWriteFileRedirection: false,
          intention: "initialize vault",
          possiblePaths: ["/repo"],
          possibleUrls: [],
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
  });

  it("allows council bundle reads and read-only provider detection but rejects mutation", async () => {
    const handler = createRlmProfilePermissionHandler(
      {
        ...defaultRlmProfileRegistry.resolve("council"),
        preparedFilesystemAccess: RlmPreparedFilesystemAccess.ReadOnly,
      },
      {
        skillDirectories: ["/cache/council/skills"],
        workingDirectory: "/cache/council/workspace",
      },
      () => ({ kind: "approve-once" }),
    );
    const invocation = { sessionId: "session" };

    expect(
      await handler(
        {
          kind: "read",
          path: "/cache/council/skills/council/configs/default.yaml",
          intention: "read config",
        },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "mcp",
          readOnly: false,
          serverName: "filesystem",
          toolName: "write_file",
          toolTitle: "Write file",
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      await handler(
        {
          kind: "hook",
          toolName: "bash",
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      await handler(
        {
          kind: "shell",
          canOfferSessionApproval: false,
          commands: [{ identifier: "env", readOnly: true }],
          fullCommandText: "env",
          hasWriteFileRedirection: false,
          intention: "detect providers",
          possiblePaths: [],
          possibleUrls: [],
        },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "shell",
          canOfferSessionApproval: false,
          commands: [{ identifier: "touch", readOnly: false }],
          fullCommandText: "touch result",
          hasWriteFileRedirection: false,
          intention: "mutate",
          possiblePaths: ["/cache/council/workspace/result"],
          possibleUrls: [],
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
  });

  it("lets the review profile read the repository but write only its own output directory", async () => {
    const handler = createRlmProfilePermissionHandler(
      defaultRlmProfileRegistry.resolve("review"),
      undefined,
      () => ({ kind: "approve-once" }),
      "/repo",
    );
    const invocation = { sessionId: "session" };

    expect(
      await handler(
        { kind: "read", path: "/repo/src/index.ts", intention: "inspect the code under review" },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "write",
          canOfferSessionApproval: false,
          diff: "",
          fileName: "/repo/.weavekit/reviews/eng-13.md",
          intention: "write the review report",
        },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "write",
          canOfferSessionApproval: false,
          diff: "",
          fileName: "/repo/docs/benchmark-report.md",
          intention: "rewrite the document under review",
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      await handler(
        {
          kind: "shell",
          canOfferSessionApproval: false,
          commands: [{ identifier: "git", readOnly: true }],
          fullCommandText: "git diff origin/main",
          hasWriteFileRedirection: false,
          intention: "read the diff under review",
          possiblePaths: ["/repo/src"],
          possibleUrls: [],
        },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "shell",
          canOfferSessionApproval: false,
          commands: [{ identifier: "sh", readOnly: false }],
          fullCommandText: "echo notes > /repo/.weavekit/reviews/notes.md",
          hasWriteFileRedirection: true,
          intention: "record review notes",
          possiblePaths: ["/repo/.weavekit/reviews/notes.md"],
          possibleUrls: [],
        },
        invocation,
      ),
    ).toEqual({ kind: "approve-once" });
    expect(
      await handler(
        {
          kind: "shell",
          canOfferSessionApproval: false,
          commands: [{ identifier: "sh", readOnly: false }],
          fullCommandText: "echo patched > /repo/docs/benchmark-report.md",
          hasWriteFileRedirection: true,
          intention: "patch the evidence",
          possiblePaths: ["/repo/docs/benchmark-report.md"],
          possibleUrls: [],
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      await handler(
        {
          kind: "mcp",
          readOnly: false,
          serverName: "filesystem",
          toolName: "write_file",
          toolTitle: "Write file",
        },
        invocation,
      ),
    ).toMatchObject({ kind: "reject" });
  });

  it("permits shell for no-write profiles that declare their own writable subpaths", async () => {
    const clientFactory = vi.fn();
    const scopedProfiles = createRlmProfileRegistry({
      scoped: {
        name: "scoped",
        description: "Destination-scoped review profile.",
        purpose: RlmProfilePurpose.Review,
        authority: RlmProfileAuthority.Review,
        repositoryWritePermission: false,
        writableSubpaths: [".weavekit/reviews"],
        model: "test-model",
        systemMessagePrompt: "Review.",
        availableTools: ["bash"],
      },
    });

    await expect(
      executeRlm({
        args: { prompt: "Review.", profile: "scoped" },
        depthRemaining: 1,
        maxDepth: 1,
        profiles: scopedProfiles,
        prepareProfileSkills: async () => ({ skillDirectories: [] }),
        clientFactory,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
      }),
    ).rejects.toThrow();
    expect(clientFactory).toHaveBeenCalled();
  });

  it("fails closed when a profile returns without invoking its required skill", async () => {
    const requiredProfiles = createRlmProfileRegistry({
      required: {
        name: "required",
        description: "Required skill test profile.",
        purpose: RlmProfilePurpose.Research,
        authority: RlmProfileAuthority.Investigation,
        repositoryWritePermission: false,
        model: "test-model",
        systemMessagePrompt: "Invoke the research skill.",
        requiredSkillNames: ["hyperresearch", "last30days"],
      },
    });
    const fake = fakeClient(fakeSession("Generic web research."));

    await expect(
      executeRlm({
        args: { prompt: "Research this.", profile: "required" },
        depthRemaining: 1,
        maxDepth: 1,
        profiles: requiredProfiles,
        prepareProfileSkills: noPreparedSkills,
        clientFactory: () => fake.client,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
      }),
    ).rejects.toThrow(
      'RLM profile "required" must invoke one of these loaded skills before returning: ' +
        "hyperresearch, last30days",
    );
  });

  it("accepts a result after a required skill invocation event", async () => {
    let handler: ((event: import("@github/copilot-sdk").SessionEvent) => void) | undefined;
    const requiredProfiles = createRlmProfileRegistry({
      required: {
        name: "required",
        description: "Required skill test profile.",
        purpose: RlmProfilePurpose.Research,
        authority: RlmProfileAuthority.Investigation,
        repositoryWritePermission: false,
        model: "test-model",
        systemMessagePrompt: "Invoke the research skill.",
        requiredSkillNames: ["hyperresearch", "last30days"],
      },
    });
    const fake = fakeClient({
      async sendAndWait() {
        handler?.({
          type: "skill.invoked",
          id: "skill-event",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            name: "hyperresearch",
            content: "Research workflow.",
            path: "/skills/hyperresearch/SKILL.md",
          },
        });
        return { data: { content: "Specialized research." } };
      },
      async disconnect() {},
      on(eventHandler) {
        handler = eventHandler;
        return () => {
          handler = undefined;
        };
      },
    });

    const result = await executeRlm({
      args: { prompt: "Research this.", profile: "required" },
      depthRemaining: 1,
      maxDepth: 1,
      profiles: requiredProfiles,
      prepareProfileSkills: noPreparedSkills,
      clientFactory: () => fake.client,
      buildNestedTool: () => ({}),
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });

    expect(result.text).toBe("Specialized research.");
  });

  it("makes a parent timeout encompass every reachable recursive child timeout", () => {
    const research = defaultRlmProfileRegistry.resolve("research");
    const general = defaultRlmProfileRegistry.resolve("general");

    expect(computeRlmSessionTimeoutMs(research, 3, defaultRlmProfileRegistry)).toBe(
      3 * 60 * 60_000,
    );
    expect(computeRlmSessionTimeoutMs(general, 3, defaultRlmProfileRegistry)).toBe(125 * 60_000);
  });

  it("returns an empty string when the nested session produces no content", async () => {
    const { client } = fakeClient({
      async sendAndWait() {
        return undefined;
      },
      async disconnect() {},
    });

    const result = await executeRlm({
      args,
      depthRemaining: 1,
      maxDepth: 1,
      profiles,
      prepareProfileSkills: noPreparedSkills,
      clientFactory: () => client,
      buildNestedTool: () => ({}),
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });

    expect(result.text).toBe("");
    expect(result.depthUsed).toBe(1);
  });

  it("still disconnects and stops the client when sendAndWait throws", async () => {
    let disconnected = false;
    let stopped = false;
    const client: RlmClient = {
      async start() {},
      async createSession() {
        return {
          async sendAndWait() {
            throw new Error("boom");
          },
          async disconnect() {
            disconnected = true;
          },
        };
      },
      async stop() {
        stopped = true;
      },
    };

    await expect(
      executeRlm({
        args,
        depthRemaining: 1,
        maxDepth: 1,
        profiles,
        prepareProfileSkills: noPreparedSkills,
        clientFactory: () => client,
        buildNestedTool: () => ({}),
        onPermissionRequest: () => ({ kind: "approve-once" }),
      }),
    ).rejects.toThrow("boom");

    expect(disconnected).toBe(true);
    expect(stopped).toBe(true);
  });
});
