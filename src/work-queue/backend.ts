import type {
  CompleteWorkItemInput,
  CreateWorkItemInput,
  ReadyWorkFilter,
  WorkItem,
} from "./schema.js";

export type WorkQueueBackend = {
  ready(filter?: ReadyWorkFilter): Promise<WorkItem[]>;
  show(id: string): Promise<WorkItem>;
  claim(id: string): Promise<WorkItem>;
  create(input: CreateWorkItemInput): Promise<WorkItem>;
  close(id: string, input: CompleteWorkItemInput): Promise<WorkItem>;
  sync(): Promise<void>;
};

export class WorkQueueBackendError extends Error {
  constructor(message: string, readonly causeDetails?: unknown) {
    super(message);
    this.name = "WorkQueueBackendError";
  }
}
