import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "./types.js";

export type WorkflowGrammar = {
  allowedNodeKinds: Set<WorkflowNodeKind>;
  allowedHarnesses: Set<WorkflowHarnessKind>;
  allowedTransitions: Map<WorkflowNodeKind, Set<WorkflowNodeKind>>;
  implementationHarnesses: Set<WorkflowHarnessKind>;
  requiredImplementationDownstreamGate: WorkflowGateKind;
  maxReplans: number;
};

export const defaultWorkflowGrammar: WorkflowGrammar = {
  allowedNodeKinds: new Set(Object.values(WorkflowNodeKind)),
  allowedHarnesses: new Set(Object.values(WorkflowHarnessKind)),
  allowedTransitions: new Map([
    [WorkflowNodeKind.RESEARCH, new Set([WorkflowNodeKind.DELIBERATION, WorkflowNodeKind.PLANNING, WorkflowNodeKind.VISUALIZATION])],
    [WorkflowNodeKind.DELIBERATION, new Set([WorkflowNodeKind.PLANNING, WorkflowNodeKind.IMPLEMENTATION, WorkflowNodeKind.VISUALIZATION])],
    [WorkflowNodeKind.PLANNING, new Set([WorkflowNodeKind.DELIBERATION, WorkflowNodeKind.IMPLEMENTATION])],
    [WorkflowNodeKind.IMPLEMENTATION, new Set([WorkflowNodeKind.VERIFICATION])],
    [WorkflowNodeKind.VERIFICATION, new Set([WorkflowNodeKind.IMPLEMENTATION, WorkflowNodeKind.VISUALIZATION])],
    [WorkflowNodeKind.VISUALIZATION, new Set<WorkflowNodeKind>()],
  ]),
  implementationHarnesses: new Set([WorkflowHarnessKind.COPILOT_SDK]),
  requiredImplementationDownstreamGate: WorkflowGateKind.VERIFICATION,
  maxReplans: 2,
};
