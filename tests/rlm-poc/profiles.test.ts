import { describe, expect, it } from "vitest";
import {
  RlmProfileAuthority,
  RlmProfilePurpose,
  RlmUnknownProfileError,
} from "../../src/rlm-poc/contracts.js";
import {
  DEFAULT_RLM_PROFILE_MODEL,
  RLM_ROOT_CAPABILITY_MANIFEST,
  RlmProfileName,
  createRlmRootAvailableTools,
  createRlmProfileRegistry,
  defaultRlmProfileRegistry,
  describeRlmProfileModelRouting,
} from "../../src/rlm-poc/profiles.js";
import { parseCopilotModelCatalog } from "../../src/rlm-poc/modelCatalog.js";

describe("rlm profile registry", () => {
  it("exposes purpose-specific built-in profiles", () => {
    const validation = defaultRlmProfileRegistry.resolve(RlmProfileName.Validation);
    const general = defaultRlmProfileRegistry.resolve(RlmProfileName.General);
    const superpowers = defaultRlmProfileRegistry.resolve(RlmProfileName.Superpowers);
    const council = defaultRlmProfileRegistry.resolve(RlmProfileName.Council);
    const research = defaultRlmProfileRegistry.resolve(RlmProfileName.Research);
    const design = defaultRlmProfileRegistry.resolve(RlmProfileName.Design);
    const media = defaultRlmProfileRegistry.resolve(RlmProfileName.Media);
    const review = defaultRlmProfileRegistry.resolve(RlmProfileName.Review);

    expect(validation.availableTools).toEqual(["builtin:ask_user", "custom:rlm", "skill"]);
    expect(validation.authority).toBe(RlmProfileAuthority.Validation);
    expect(validation.repositoryWritePermission).toBe(false);
    expect(validation.allowedChildProfiles).toEqual(["validation"]);
    expect(validation.model).toBe("gemini-3.6-flash");
    expect(general.availableTools).toBeUndefined();
    expect(general.skillBundle).toBeUndefined();
    expect(general.authority).toBe(RlmProfileAuthority.Implementation);
    expect(general.repositoryWritePermission).toBe(true);
    expect(general.allowedChildProfiles).toEqual(Object.values(RlmProfileName));
    expect(superpowers.skillBundle).toBe("superpowers");
    expect(superpowers.allowedSkillNames).toContain("test-driven-development");
    expect(superpowers.allowedChildProfiles).toContain("review");
    expect(superpowers.model).toBe("gpt-5.6-sol");
    expect(superpowers.reasoningEffort).toBe("medium");
    expect(council.skillBundle).toBe("council");
    expect(council.authority).toBe(RlmProfileAuthority.Investigation);
    expect(council.repositoryWritePermission).toBe(false);
    expect(council.availableTools).toEqual(expect.arrayContaining(["bash", "view", "glob"]));
    expect(council.systemMessagePrompt).toContain("/council");
    expect(council.sendTimeoutMs).toBe(20 * 60_000);
    expect(council.model).toBe("gpt-5.6-sol");
    expect(council.reasoningEffort).toBe("medium");
    expect(research.skillBundle).toBe("research");
    expect(research.authority).toBe(RlmProfileAuthority.Investigation);
    expect(research.repositoryWritePermission).toBe(false);
    expect(research.systemMessagePrompt).toContain("invoke `hyperresearch`");
    expect(research.systemMessagePrompt).toContain("or `last30days`");
    expect(research.requiredSkillNames).toContain("hyperresearch");
    expect(research.requiredSkillNames).toContain("last30days");
    expect(research.allowedSkillNames).toHaveLength(20);
    expect(research.availableTools).toEqual(expect.arrayContaining(["bash", "view", "glob"]));
    expect(research.systemMessagePrompt).toContain("first action must be");
    expect(research.sendTimeoutMs).toBe(60 * 60_000);
    expect(research.model).toBe("gpt-5.6-sol");
    expect(research.reasoningEffort).toBe("medium");
    expect(design.skillBundle).toBe("design");
    expect(design.authority).toBe(RlmProfileAuthority.Implementation);
    expect(design.repositoryWritePermission).toBe(true);
    expect(design.allowedSkillNames).toContain("visual-plan");
    expect(design.allowedSkillNames).toContain("critique-visual-hierarchy");
    expect(design.allowedSkillNames).toContain("infographic-structure-creator");
    expect(design.allowedSkillNames).toContain("design-token");
    expect(design.allowedSkillNames).not.toContain("visual-critique");
    expect(design.model).toBe("claude-opus-5");
    expect(design.reasoningEffort).toBe("medium");
    expect(design.systemMessagePrompt).toContain("visual-plan");
    expect(design.systemMessagePrompt).toContain("infographic-creator");
    expect(design.systemMessagePrompt).toContain("frontend-design");
    expect(design.systemMessagePrompt).toContain("img2threejs");
    expect(design.allowedChildProfiles).toContain("research");
    expect(design.allowedChildProfiles).toContain("media");
    expect(media.skillBundle).toBe("media");
    expect(media.purpose).toBe(RlmProfilePurpose.Media);
    expect(media.authority).toBe(RlmProfileAuthority.Investigation);
    expect(media.repositoryWritePermission).toBe(false);
    expect(media.allowedSkillNames).toEqual(["watch-video"]);
    expect(media.requiredSkillNames).toEqual(["watch-video"]);
    expect(media.availableTools).toContain("bash");
    expect(media.systemMessagePrompt).toContain("first action must be");
    expect(media.systemMessagePrompt).toContain("invoking `watch-video`");
    expect(media.systemMessagePrompt).toContain("transcript, visual, or multimodal");
    expect(media.systemMessagePrompt).toContain("`copilot-proxy-rs` Anthropic image path");
    expect(media.systemMessagePrompt).toContain("never require `GEMINI_API_KEY`");
    expect(media.sendTimeoutMs).toBe(60 * 60_000);
    expect(media.allowedChildProfiles).toContain("research");
    expect(media.allowedChildProfiles).not.toContain("design");
    expect(media.model).toBe("claude-opus-5");
    expect(review.availableTools).toEqual(["builtin:ask_user", "custom:rlm", "skill"]);
    expect(review.authority).toBe(RlmProfileAuthority.Review);
    expect(review.repositoryWritePermission).toBe(false);
    expect(review.allowedChildProfiles).toEqual(["review"]);
    expect(review.purpose).toBe(RlmProfilePurpose.Review);
    expect(review.model).toBe("claude-opus-5");
    expect(review.reasoningEffort).toBe("medium");
    expect(DEFAULT_RLM_PROFILE_MODEL).toBe("mai-code-1.1-flash");
    expect(general.model).toBe(DEFAULT_RLM_PROFILE_MODEL);
    for (const profile of defaultRlmProfileRegistry.list()) {
      expect(profile.systemMessagePrompt).toContain(
        "Native `ask_user` is available and encouraged",
      );
      expect(profile.systemMessagePrompt).toContain("root Submind conversation");
      expect(profile.systemMessagePrompt).toContain("loaded `rlm-handoff` skill");
      expect(profile.systemMessagePrompt).toContain("loaded `better-github-skill`");
    }
    expect(defaultRlmProfileRegistry.list().map((profile) => profile.name)).toEqual([
      "validation",
      "general",
      "superpowers",
      "council",
      "research",
      "design",
      "media",
      "review",
    ]);
  });

  it("keeps the d0 root routing-only while retaining discovered MCP access", () => {
    expect(RLM_ROOT_CAPABILITY_MANIFEST.repositoryWritePermission).toBe(false);
    expect(RLM_ROOT_CAPABILITY_MANIFEST.allowedSkillNames).toEqual([]);
    expect(createRlmRootAvailableTools(false)).toEqual(["custom:rlm", "mcp:*"]);
    expect(createRlmRootAvailableTools(true)).toContain("custom:invoke_trellage");
  });

  it("throws RlmUnknownProfileError for an unresolvable profile name", () => {
    expect(() => defaultRlmProfileRegistry.resolve("does-not-exist")).toThrow(
      RlmUnknownProfileError,
    );
  });

  it("describes current profile candidates without starting a session", () => {
    const catalog = parseCopilotModelCatalog({
      groups: {
        "frontier-current": [],
        "balanced-workhorse": [],
        "coding-specialist": [],
        "fast-efficient": ["gemini-3.6-flash"],
      },
      models: [
        {
          id: "gemini-3.6-flash",
          name: "Gemini 3.6 Flash",
          description: "Fast tool model.",
          preview: false,
          capabilities: {
            reasoning: true,
            tool_call: true,
            structured_output: true,
            attachments: true,
          },
        },
      ],
    });

    expect(
      describeRlmProfileModelRouting(catalog).find(
        ({ profile }) => profile === RlmProfileName.Validation,
      ),
    ).toMatchObject({
      fallbackModel: "gemini-3.6-flash",
      candidates: [{ id: "gemini-3.6-flash", group: "fast-efficient" }],
    });
  });

  it("layers overrides over the built-in defaults without losing them", () => {
    const registry = createRlmProfileRegistry({
      concise: {
        name: "concise",
        description: "Concise test profile.",
        purpose: RlmProfilePurpose.Submind,
        authority: RlmProfileAuthority.Implementation,
        repositoryWritePermission: true,
        model: "gpt-5-mini",
        systemMessagePrompt: "Answer in one short sentence.",
      },
    });
    expect(registry.resolve("concise").model).toBe("gpt-5-mini");
    expect(registry.resolve("general").name).toBe("general");
  });

  it("an override can add a caller-defined compatibility profile", () => {
    const registry = createRlmProfileRegistry({
      default: {
        name: "default",
        description: "Custom default.",
        purpose: RlmProfilePurpose.Submind,
        authority: RlmProfileAuthority.Implementation,
        repositoryWritePermission: true,
        model: "custom-model",
        systemMessagePrompt: "Custom.",
      },
    });
    expect(registry.resolve("default").model).toBe("custom-model");
  });
});
