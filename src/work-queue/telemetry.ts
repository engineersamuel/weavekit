import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { setSerializedAttribute } from "../decision-council/bamlTelemetry.js";
import type { WorkItem } from "./schema.js";

export type WorkQueueOperation = "show" | "claim" | "create-follow-up" | "close" | "sync" | "create-workflow" | "create-workflow-item";

export type WorkQueueTelemetryContext = {
  itemId: string;
  item?: WorkItem;
};

export type WorkItemWorkflowDag = {
  rootItemId: string;
  activeItemId: string;
  items: ReturnType<typeof serializeWorkItemDag>[];
};

const tracer = trace.getTracer("weavekit.work-queue");

export function serializeWorkItemDag(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    type: item.type,
    priority: item.priority,
    labels: item.labels,
    dependencies: item.dependencies,
  };
}

export function setWorkItemTraceAttributes(span: Pick<Span, "setAttribute">, item: WorkItem): void {
  span.setAttribute("weavekit.work_queue.item_id", item.id);
  span.setAttribute("weavekit.work_queue.item_title", item.title);
  span.setAttribute("weavekit.work_queue.item_status", item.status);
  span.setAttribute("weavekit.work_queue.item_type", item.type);
  span.setAttribute("weavekit.work_queue.dependency_count", item.dependencies.length);
  span.setAttribute("langfuse.trace.metadata.beads.item_id", item.id);
  span.setAttribute("langfuse.trace.metadata.beads.item_title", item.title);
  setSerializedAttribute(span as Span, "langfuse.trace.metadata.beads.dag", serializeWorkItemDag(item));
}

export function serializeWorkItemWorkflowDag(args: {
  rootItemId: string;
  activeItemId: string;
  items: WorkItem[];
}): WorkItemWorkflowDag {
  return {
    rootItemId: args.rootItemId,
    activeItemId: args.activeItemId,
    items: args.items.map(serializeWorkItemDag),
  };
}

export function setWorkItemWorkflowTraceAttributes(
  span: Pick<Span, "setAttribute">,
  dag: WorkItemWorkflowDag,
): void {
  span.setAttribute("weavekit.work_queue.workflow_root_item_id", dag.rootItemId);
  span.setAttribute("weavekit.work_queue.workflow_active_item_id", dag.activeItemId);
  span.setAttribute("weavekit.work_queue.workflow_item_count", dag.items.length);
  setSerializedAttribute(span as Span, "langfuse.trace.metadata.beads.workflow_dag", dag);
}

export async function runWorkQueueSpan<T>(
  operation: WorkQueueOperation,
  context: WorkQueueTelemetryContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`work-queue.beads.${operation}`, async (span) => {
    span.setAttribute("weavekit.work_queue.backend", "beads");
    span.setAttribute("weavekit.work_queue.operation", operation);
    span.setAttribute("weavekit.work_queue.item_id", context.itemId);
    span.setAttribute("langfuse.observation.type", "span");
    setSerializedAttribute(span, "langfuse.observation.input", context);
    if (context.item) setWorkItemTraceAttributes(span, context.item);

    try {
      const result = await fn();
      setSerializedAttribute(span, "langfuse.observation.output", result);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
