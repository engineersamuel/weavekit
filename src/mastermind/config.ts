import type { MastermindDefaults, ProjectCatalogEntry, WeavekitConfig } from "../config.js";
import { ProjectRepositoryMode, resolveProjectCatalogEntry } from "../config.js";
import {
  ProjectRepositoryMode as BamlProjectRepositoryMode,
  type MastermindProjectPolicyInput,
} from "../generated/baml_client/index.js";
import type { LinearTicketSnapshot } from "./store/store.js";

export type ResolvedMastermindProjectPolicy = {
  baml: MastermindProjectPolicyInput;
  project: ProjectCatalogEntry;
};

export function validateMastermindRuntimeConfig(
  config: MastermindDefaults,
  env: NodeJS.ProcessEnv,
): void {
  const missing: string[] = [];
  if (!env.LINEAR_API_KEY?.trim()) missing.push("LINEAR_API_KEY");
  if (!env.LINEAR_WEBHOOK_SECRET?.trim()) missing.push("LINEAR_WEBHOOK_SECRET");
  if (!config.reviewedLabelId.trim()) missing.push("mastermind.reviewed_label_id");
  if (!config.readyLabelId.trim()) missing.push("mastermind.ready_label_id");
  if (!config.needsInputLabelId.trim()) missing.push("mastermind.needs_input_label_id");
  if (!config.reviewFailedLabelId.trim()) missing.push("mastermind.review_failed_label_id");
  if (!config.linearOrganizationId?.trim()) missing.push("mastermind.linear_organization_id");
  if (config.projectMappings.length === 0) missing.push("mastermind.project_mappings");
  if (missing.length > 0) {
    throw new Error(`Mastermind configuration missing: ${missing.join(", ")}`);
  }
}

export function validateMastermindExecutionRuntimeConfig(
  config: MastermindDefaults,
  env: NodeJS.ProcessEnv,
): void {
  const missing: string[] = [];
  if (!env.LINEAR_API_KEY?.trim()) missing.push("LINEAR_API_KEY");
  if (!config.execution && !config.rlmExecution) {
    missing.push("mastermind.execution or mastermind.rlm_execution");
  }
  if (!config.readyLabelId.trim()) missing.push("mastermind.ready_label_id");
  if (!config.needsInputLabelId.trim()) missing.push("mastermind.needs_input_label_id");
  if (!config.reviewFailedLabelId.trim()) missing.push("mastermind.review_failed_label_id");
  if (missing.length > 0) {
    throw new Error(`Mastermind execution configuration missing: ${missing.join(", ")}`);
  }
}

export function resolveMastermindProjectPolicy(
  config: WeavekitConfig,
  ticket: LinearTicketSnapshot,
): ResolvedMastermindProjectPolicy | undefined {
  const mapping = config.mastermind.projectMappings.find(
    (candidate) =>
      candidate.teamId === ticket.teamId &&
      (candidate.linearProjectId === undefined || candidate.linearProjectId === ticket.projectId),
  );
  if (!mapping) {
    return undefined;
  }
  const project = resolveProjectCatalogEntry(config, mapping.projectId);
  return resolveMastermindProjectPolicyForProject(config, project);
}

export function resolveMastermindProjectPolicyForProject(
  config: WeavekitConfig,
  project: ProjectCatalogEntry,
): ResolvedMastermindProjectPolicy {
  const repositoryMode = project.repositoryMode ?? ProjectRepositoryMode.EXISTING_REPOSITORY;
  return {
    project,
    baml: {
      id: project.id,
      displayName: project.displayName,
      repositoryMode:
        repositoryMode === ProjectRepositoryMode.GREENFIELD
          ? BamlProjectRepositoryMode.GREENFIELD
          : BamlProjectRepositoryMode.EXISTING_REPOSITORY,
      ...(repositoryMode === ProjectRepositoryMode.EXISTING_REPOSITORY
        ? { repositoryPath: project.workingTree }
        : { provisioningRoot: project.provisioningRoot }),
      allowedActions: config.mastermind.allowedActions,
    },
  };
}
