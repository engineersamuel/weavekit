import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectRepositoryMode, type ProjectCatalogEntry } from "../config.js";
import { TicketKind, type TicketReviewDossier } from "../generated/baml_client/index.js";
import type { LinearTicketSnapshot } from "./store/store.js";

export function resolveReviewedExecutionProject(input: {
  ticket: LinearTicketSnapshot;
  dossier: Pick<TicketReviewDossier, "ticketKind">;
  mappedProject: ProjectCatalogEntry;
  prototypeRoot?: string;
}): ProjectCatalogEntry {
  if (input.dossier.ticketKind !== TicketKind.SPIKE) {
    return input.mappedProject;
  }
  const id = `prototype-${input.ticket.identifier.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
  return {
    ...input.mappedProject,
    id,
    displayName: input.ticket.title,
    workingTree: "",
    repositoryMode: ProjectRepositoryMode.GREENFIELD,
    provisioningRoot: input.prototypeRoot ?? join(homedir(), "projects", "prototypes"),
    mainline: "main",
    remote: "origin",
    contextDocs: [],
    validationCommands: [],
  };
}
