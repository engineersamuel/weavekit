export class CouncilRunFailedError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CouncilRunFailedError";
    this.exitCode = exitCode;
  }
}
