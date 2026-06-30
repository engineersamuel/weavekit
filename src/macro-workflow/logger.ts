export const MacroWorkflowEventKind = {
  RUN_STARTED: "macro-workflow.run.started",
  NODE_STARTED: "macro-workflow.node.started",
  NODE_COMPLETED: "macro-workflow.node.completed",
  NODE_FAILED: "macro-workflow.node.failed",
  REPLAN_APPLIED: "macro-workflow.replan.applied",
  RUN_COMPLETED: "macro-workflow.run.completed",
} as const;
export type MacroWorkflowEventKind = (typeof MacroWorkflowEventKind)[keyof typeof MacroWorkflowEventKind];

export type MacroWorkflowEvent = {
  type?: string;
  kind?: MacroWorkflowEventKind;
  planId?: string;
  nodeId?: string;
  status?: string;
  reason?: string;
  payload?: Record<string, unknown>;
  timestamp: Date;
};

export type MacroWorkflowLogger = {
  emit(event: MacroWorkflowEvent): void;
  events: MacroWorkflowEvent[];
};

export function createInMemoryMacroWorkflowLogger(): MacroWorkflowLogger {
  return {
    events: [],
    emit(event: MacroWorkflowEvent) {
      this.events.push(event);
    },
  };
}
