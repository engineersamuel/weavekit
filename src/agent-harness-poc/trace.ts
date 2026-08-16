export type TraceEvent = {
  ts: string;
  type: string;
  message?: string;
  meta?: Record<string, unknown>;
};

export class Trace {
  private events: TraceEvent[] = [];

  push(type: string, message?: string, meta?: Record<string, unknown>): void {
    this.events.push({
      ts: new Date().toISOString(),
      type,
      ...(message ? { message } : {}),
      ...(meta ? { meta } : {}),
    });
  }

  list(): TraceEvent[] {
    return [...this.events];
  }
}
