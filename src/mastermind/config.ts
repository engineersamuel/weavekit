import type { MastermindDefaults, ProjectCatalogEntry, WeavekitConfig } from "../config.js";
import type { ExecutorKind as ExecutorKindValue } from "../submind/contracts.js";
import { ProjectRepositoryMode, resolveProjectCatalogEntry } from "../config.js";
import {
  MastermindAction,
  ProjectRepositoryMode as BamlProjectRepositoryMode,
  type MastermindAction as MastermindActionValue,
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

/**
 * `mastermind.allowed_actions` is global, but the executor each execution action resolves to is
 * per-project (`projects.<id>.execution.direct.allowed_executors`). Offering the decider an
 * execution action the project cannot execute makes it plan that action and then have
 * `beginExecution` silently decline, which surfaces only as "did not start direct execution".
 * Drop those actions here so the decider never plans one, mirroring the executor resolution in
 * `MastermindExecutionCoordinator.resolveExecutionSelectionForAction`. Non-execution actions
 * (review, wait, needs-human, ignore) are never filtered.
 */
function executableAllowedActions(
  config: WeavekitConfig,
  project: ProjectCatalogEntry,
): MastermindActionValue[] {
  const executorForAction = new Map<MastermindActionValue, ExecutorKindValue | undefined>([
    [MastermindAction.IMPLEMENT_DIRECTLY, config.mastermind.execution?.executorKind],
    [MastermindAction.DELEGATE_SUBMIND, config.mastermind.rlmExecution?.executorKind],
  ]);
  const direct = project.directExecution;
  return config.mastermind.allowedActions.filter((action) => {
    if (!executorForAction.has(action)) return true;
    const executorKind = executorForAction.get(action);
    if (executorKind === undefined) return false;
    return Boolean(direct?.enabled) && direct!.allowedExecutorKinds.includes(executorKind);
  });
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
      allowedActions: executableAllowedActions(config, project),
      contextDocs: [...project.contextDocs],
    },
  };
}
