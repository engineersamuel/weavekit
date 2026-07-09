import type {
  RuntimeWorkflowNode,
  WorkflowArtifactRef,
  WorkflowExecutionMetadata,
  WorkflowNodePayload,
  WorkflowNodeStatus,
} from "./types.js";
import { WorkflowHarnessKind } from "./types.js";

export type WorkflowExecutionContext = {
  payloads: Map<string, WorkflowNodePayload>;
  artifacts: Map<string, WorkflowArtifactRef[]>;
  objective?: string;
  outputDir?: string;
  preparedExecution?: WorkflowExecutionMetadata;
};

export type HarnessExecutionResult = {
  status: WorkflowNodeStatus;
  output: string;
  error?: string;
  payload?: WorkflowNodePayload;
  artifacts?: WorkflowArtifactRef[];
  execution?: WorkflowExecutionMetadata;
};

export type HarnessAdapter = {
  (node: RuntimeWorkflowNode, context: WorkflowExecutionContext): Promise<HarnessExecutionResult>;
  prepareExecution?: (
    node: RuntimeWorkflowNode,
    context: WorkflowExecutionContext,
  ) => Promise<WorkflowExecutionMetadata | undefined> | WorkflowExecutionMetadata | undefined;
};
export type HarnessRegistry = Map<WorkflowHarnessKind, HarnessAdapter>;

export function createStaticHarnessRegistry(
  overrides: Partial<Record<WorkflowHarnessKind, HarnessAdapter>> = {},
): HarnessRegistry {
  const registry = new Map<WorkflowHarnessKind, HarnessAdapter>([
    [
      WorkflowHarnessKind.RESEARCH,
      () => Promise.resolve({ status: "passed", output: "Research complete." }),
    ],
    [
      WorkflowHarnessKind.DECISION_COUNCIL,
      () => Promise.resolve({ status: "passed", output: "Council review complete." }),
    ],
    [
      WorkflowHarnessKind.COPILOT_SDK,
      () => Promise.resolve({ status: "passed", output: "Implementation complete." }),
    ],
    [
      WorkflowHarnessKind.VERIFIER,
      () => Promise.resolve({ status: "passed", output: "Verification complete." }),
    ],
    [
      WorkflowHarnessKind.REPORTER,
      () => Promise.resolve({ status: "passed", output: "Report generated." }),
    ],
  ]);

  for (const [kind, adapter] of Object.entries(overrides) as Array<
    [WorkflowHarnessKind, HarnessAdapter]
  >) {
    registry.set(kind, adapter);
  }
  return registry;
}

export function resolveHarnessAdapter(
  registry: HarnessRegistry,
  kind: WorkflowHarnessKind,
): HarnessAdapter {
  const adapter = registry.get(kind);
  if (!adapter) {
    return () => Promise.resolve({ status: "passed", output: `Harness ${kind} completed.` });
  }
  return adapter;
}
