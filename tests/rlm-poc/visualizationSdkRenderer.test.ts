import type { SessionEvent, ToolResultObject } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { RLM_STORYBOARD_SKILL_NAMES } from "../../src/rlm-poc/profileSkills.js";
import type { RlmClient, RlmSession } from "../../src/rlm-poc/session.js";
import { createCopilotSdkRlmStoryboardRenderer } from "../../src/rlm-poc/visualization/index.js";

const SKILLS = "/tmp/weavekit-storyboard-skills";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 800"><rect width="1400" height="800" fill="#111"/></svg>';

type CapturedTool = {
  handler(input: unknown, invocation: { toolCallId: string }): Promise<ToolResultObject>;
};

function createFakeStack(options: { submit?: boolean; invalidFirstSubmission?: boolean } = {}) {
  let sessionConfig: Record<string, unknown> | undefined;
  let eventHandler: ((event: SessionEvent) => void) | undefined;
  let starts = 0;
  let stops = 0;
  let disconnects = 0;
  const prompts: string[] = [];
  const toolResults: ToolResultObject[] = [];
  let sends = 0;

  const session: RlmSession = {
    async sendAndWait({ prompt }) {
      sends += 1;
      prompts.push(prompt);
      if (sends === 1) {
        for (const name of RLM_STORYBOARD_SKILL_NAMES) {
          eventHandler?.({
            type: "skill.invoked",
            id: `skill-${name}`,
            parentId: null,
            timestamp: new Date().toISOString(),
            data: {
              name,
              content: `${name} workflow`,
              path: `${SKILLS}/${name}/SKILL.md`,
            },
          });
        }
      }
      if (options.submit !== false) {
        const tool = (sessionConfig?.tools as CapturedTool[] | undefined)?.[0];
        if (options.invalidFirstSubmission) {
          const result = await tool?.handler(
            {
              title: `Revision ${sends}`,
              summary: "The run is progressing.",
              narrative: [`Beat ${sends}`],
              styleGuide: "Ink black, paper white, safety orange.",
              svg: SVG.replace("<rect ", "<animate></animate><rect "),
            },
            { toolCallId: `invalid-${sends}` },
          );
          if (result) toolResults.push(result);
        }
        const result = await tool?.handler(
          {
            title: `Revision ${sends}`,
            summary: "The run is progressing.",
            narrative: [`Beat ${sends}`],
            styleGuide: "Ink black, paper white, safety orange; condensed editorial typography.",
            svg: SVG,
          },
          { toolCallId: `submit-${sends}` },
        );
        if (result) toolResults.push(result);
      }
      return { data: { content: "" } };
    },
    async disconnect() {
      disconnects += 1;
    },
    on(handler) {
      eventHandler = handler;
      return () => {
        eventHandler = undefined;
      };
    },
    rpc: {
      skills: {
        async ensureLoaded() {},
        async list() {
          return {
            skills: [
              ...RLM_STORYBOARD_SKILL_NAMES.map((name) => ({
                name,
                source: "custom",
                enabled: true,
                path: `${SKILLS}/${name}/SKILL.md`,
              })),
              {
                name: "project-extra",
                source: "project",
                enabled: false,
                path: "/tmp/project/.agents/skills/project-extra/SKILL.md",
              },
            ],
          };
        },
      },
    },
  };
  const client: RlmClient = {
    async start() {
      starts += 1;
    },
    async createSession(config) {
      sessionConfig = config;
      return session;
    },
    async stop() {
      stops += 1;
    },
    rpc: {
      skills: {
        async discover() {
          return {
            skills: [
              ...RLM_STORYBOARD_SKILL_NAMES.map((name) => ({
                name,
                source: "custom",
                enabled: true,
                path: `${SKILLS}/${name}/SKILL.md`,
              })),
              {
                name: "project-extra",
                source: "project",
                enabled: true,
                path: "/tmp/project/.agents/skills/project-extra/SKILL.md",
              },
            ],
          };
        },
      },
    },
  };

  return {
    client,
    sessionConfig: () => sessionConfig,
    prompts,
    toolResults,
    counts: () => ({ starts, stops, disconnects, sends }),
  };
}

describe("createCopilotSdkRlmStoryboardRenderer", () => {
  it("reuses one restricted Gemini session and preserves the skill-built style guide", async () => {
    const fake = createFakeStack();
    const renderer = createCopilotSdkRlmStoryboardRenderer({
      workingDirectory: "/tmp/worktree",
      clientFactory: () => fake.client,
      prepareSkills: async () => ({ skillDirectories: [SKILLS] }),
    });

    await expect(
      renderer({
        objective: "Explain the recursive work.",
        runStatus: "running",
        eventLedger: "#1 rlm succeeded",
      }),
    ).resolves.toMatchObject({ title: "Revision 1", svg: SVG });
    await expect(
      renderer({
        objective: "Explain the recursive work.",
        runStatus: "succeeded",
        eventLedger: "#1 rlm succeeded\n#2 invoke_trellage succeeded",
        finalSummary: "Succeeded: shipped the storyboard fix and verified with vitest.",
      }),
    ).resolves.toMatchObject({ title: "Revision 2" });

    expect(fake.counts()).toMatchObject({ starts: 1, sends: 2 });
    expect(fake.sessionConfig()).toMatchObject({
      model: "gemini-3.7-flash",
      enableSkills: true,
      availableTools: ["skill", "custom:submit_storyboard"],
      skillDirectories: [SKILLS],
      disabledSkills: ["project-extra"],
      workingDirectory: "/tmp/worktree",
    });
    expect(fake.prompts[0]).toContain(RLM_STORYBOARD_SKILL_NAMES.join(", "));
    expect(fake.prompts[0]).not.toContain("<final-result>");
    expect(fake.prompts[1]).toContain("Ink black, paper white, safety orange");
    // The terminal request's prompt must carry the Submind's own final result text so the last
    // frame reflects the complete run, not only the delegation ledger.
    expect(fake.prompts[1]).toContain("<final-result>");
    expect(fake.prompts[1]).toContain(
      "Succeeded: shipped the storyboard fix and verified with vitest.",
    );

    await renderer.dispose?.();
    expect(fake.counts()).toMatchObject({ stops: 1, disconnects: 1 });
  });

  it("fails closed when the SDK agent does not submit through the typed tool", async () => {
    const fake = createFakeStack({ submit: false });
    const renderer = createCopilotSdkRlmStoryboardRenderer({
      workingDirectory: "/tmp/worktree",
      clientFactory: () => fake.client,
      prepareSkills: async () => ({ skillDirectories: [SKILLS] }),
    });

    await expect(
      renderer({
        objective: "Explain the recursive work.",
        runStatus: "running",
        eventLedger: "#1 rlm succeeded",
      }),
    ).rejects.toThrow("without calling submit_storyboard");
    await renderer.dispose?.();
  });

  it("rejects an unsafe tool submission and accepts a corrected SVG in the same turn", async () => {
    const fake = createFakeStack({ invalidFirstSubmission: true });
    const renderer = createCopilotSdkRlmStoryboardRenderer({
      workingDirectory: "/tmp/worktree",
      clientFactory: () => fake.client,
      prepareSkills: async () => ({ skillDirectories: [SKILLS] }),
    });

    await expect(
      renderer({
        objective: "Explain the recursive work.",
        runStatus: "running",
        eventLedger: "(no completed calls yet)",
      }),
    ).resolves.toMatchObject({ title: "Revision 1", svg: SVG });
    expect(fake.toolResults.map((result) => result.resultType)).toEqual(["failure", "success"]);
    expect(fake.toolResults[0]).toMatchObject({
      textResultForLlm: expect.stringContaining("contains a <animate> element"),
    });
    await renderer.dispose?.();
  });
});
