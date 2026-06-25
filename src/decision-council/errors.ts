export class DecisionCouncilRunFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "DecisionCouncilRunFailedError";
    this.exitCode = exitCode;
  }
}
