export type ApprovalRequest = {
  actor: string;
  action: string;
  details?: Record<string, unknown>;
};

export interface ApprovalGate {
  requestApproval(request: ApprovalRequest): Promise<boolean>;
}

export class DeterministicApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  private readonly allow: boolean;

  constructor(allow: boolean) {
    this.allow = allow;
  }

  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return this.allow;
  }
}
