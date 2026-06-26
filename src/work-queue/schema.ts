import { z } from "zod";

export const WorkDependencyTypeSchema = z.enum([
  "blocks",
  "parent-child",
  "discovered-from",
  "related",
  "waits-for",
]);

export type WorkDependencyType = z.infer<typeof WorkDependencyTypeSchema>;

export const WorkDependencySchema = z.object({
  type: WorkDependencyTypeSchema,
  id: z.string().min(1),
});

export type WorkDependency = z.infer<typeof WorkDependencySchema>;

export const WorkItemTypeSchema = z.enum(["bug", "feature", "task", "epic", "chore"]);
export type WorkItemType = z.infer<typeof WorkItemTypeSchema>;

export const WorkItemStatusSchema = z.enum(["open", "in_progress", "blocked", "closed"]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  status: WorkItemStatusSchema,
  type: WorkItemTypeSchema,
  priority: z.number().int().min(0).max(4),
  assignee: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).default([]),
  dependencies: z.array(WorkDependencySchema).default([]),
});

export type WorkItem = z.infer<typeof WorkItemSchema>;

export const ReadyWorkFilterSchema = z.object({
  priority: z.number().int().min(0).max(4).optional(),
  assignee: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

export type ReadyWorkFilter = z.infer<typeof ReadyWorkFilterSchema>;

export const CreateWorkItemInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  type: WorkItemTypeSchema.default("task"),
  priority: z.number().int().min(0).max(4).default(2),
  labels: z.array(z.string().min(1)).default([]),
  dependencies: z.array(WorkDependencySchema).default([]),
});

export type CreateWorkItemInput = z.infer<typeof CreateWorkItemInputSchema>;

export const CompleteWorkItemInputSchema = z.object({
  reason: z.string().min(1),
});

export type CompleteWorkItemInput = z.infer<typeof CompleteWorkItemInputSchema>;
