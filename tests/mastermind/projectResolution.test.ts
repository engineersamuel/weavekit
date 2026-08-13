import { describe, expect, it } from "vitest";
import { ProjectRepositoryMode, type ProjectCatalogEntry } from "../../src/config.js";
import { TicketKind } from "../../src/generated/baml_client/index.js";
import { resolveReviewedExecutionProject } from "../../src/mastermind/projectResolution.js";
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
