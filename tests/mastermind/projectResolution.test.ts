import { describe, expect, it } from "vitest";
import {
  ProjectRepositoryMode,
  type ProjectCatalogEntry,
  type WeavekitConfig,
} from "../../src/config.js";
import { MastermindAction, TicketKind } from "../../src/generated/baml_client/index.js";
import { resolveMastermindProjectPolicyForProject } from "../../src/mastermind/config.js";
import { resolveReviewedExecutionProject } from "../../src/mastermind/projectResolution.js";
import { ExecutorKind } from "../../src/submind/contracts.js";
import type { LinearTicketSnapshot } from "../../src/mastermind/store/store.js";

const mappedProject: ProjectCatalogEntry = {
  id: "weavekit",
  displayName: "weavekit",
  workingTree: "/projects/weavekit",
  repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
  mainline: "origin main",
  remote: "origin",
  contextDocs: ["CONTEXT.md"],
  validationCommands: ["nub run test"],
  autonomousPrAllowed: false,
  notification: "cli",
  knowledgeExport: "off",
};

const ticket: LinearTicketSnapshot = {
  id: "issue-10",
  identifier: "ENG-10",
  url: "https://linear.app/issue/ENG-10",
  title: "Prototype an Azure markdown agent",
  description: "Build a greenfield prototype.",
  labels: [],
  status: "Todo",
  teamId: "team-eng",
};

describe("reviewed execution project resolution", () => {
  it("routes spike work to a stable greenfield project under the prototype root", () => {
    const project = resolveReviewedExecutionProject({
      ticket,
      dossier: { ticketKind: TicketKind.SPIKE },
      mappedProject,
      prototypeRoot: "/home/test/projects/prototypes",
    });

    expect(project).toMatchObject({
      id: "prototype-eng-10",
      displayName: ticket.title,
      workingTree: "",
      repositoryMode: ProjectRepositoryMode.GREENFIELD,
      provisioningRoot: "/home/test/projects/prototypes",
      mainline: "main",
      validationCommands: [],
      // The mapped project's repository-relative paths do not exist in a fresh prototype worktree.
      contextDocs: [],
    });
    expect(project.directExecution).toBe(mappedProject.directExecution);
  });

  it("keeps the mapped project for non-spike work", () => {
    expect(
      resolveReviewedExecutionProject({
        ticket,
        dossier: { ticketKind: TicketKind.TECHNICAL_TASK },
        mappedProject,
      }),
    ).toBe(mappedProject);
  });
});

function createPolicyConfig(): WeavekitConfig {
  return {
    mastermind: {
      allowedActions: [
        MastermindAction.REVIEW_TICKET,
        MastermindAction.IMPLEMENT_DIRECTLY,
        MastermindAction.DELEGATE_SUBMIND,
        MastermindAction.WAIT,
        MastermindAction.NEEDS_HUMAN,
        MastermindAction.IGNORE,
      ],
      execution: { executorKind: ExecutorKind.HERDR_COPILOT },
      rlmExecution: { executorKind: ExecutorKind.RLM_SUBMIND },
    },
  } as unknown as WeavekitConfig;
}

describe("mastermind project policy allowed actions", () => {
  it("drops execution actions whose executor the project does not allow", () => {
    const project: ProjectCatalogEntry = {
      ...mappedProject,
      directExecution: {
        enabled: true,
        allowedExecutorKinds: [ExecutorKind.RLM_SUBMIND],
        allowedPullRequestHosts: [],
      },
    };

    const policy = resolveMastermindProjectPolicyForProject(createPolicyConfig(), project);

    expect(policy.baml.allowedActions).toEqual([
      MastermindAction.REVIEW_TICKET,
      MastermindAction.DELEGATE_SUBMIND,
      MastermindAction.WAIT,
      MastermindAction.NEEDS_HUMAN,
      MastermindAction.IGNORE,
    ]);
  });

  it("drops every execution action when the project has no direct execution opt-in", () => {
    const policy = resolveMastermindProjectPolicyForProject(createPolicyConfig(), mappedProject);

    expect(policy.baml.allowedActions).toEqual([
      MastermindAction.REVIEW_TICKET,
      MastermindAction.WAIT,
      MastermindAction.NEEDS_HUMAN,
      MastermindAction.IGNORE,
    ]);
  });

  it("drops an execution action the global configuration never configured an executor for", () => {
    const config = createPolicyConfig();
    const withoutRlm = {
      ...config,
      mastermind: { ...config.mastermind, rlmExecution: undefined },
    } as WeavekitConfig;
    const project: ProjectCatalogEntry = {
      ...mappedProject,
      directExecution: {
        enabled: true,
        allowedExecutorKinds: [ExecutorKind.HERDR_COPILOT, ExecutorKind.RLM_SUBMIND],
        allowedPullRequestHosts: [],
      },
    };

    const policy = resolveMastermindProjectPolicyForProject(withoutRlm, project);

    expect(policy.baml.allowedActions).toContain(MastermindAction.IMPLEMENT_DIRECTLY);
    expect(policy.baml.allowedActions).not.toContain(MastermindAction.DELEGATE_SUBMIND);
  });
});
