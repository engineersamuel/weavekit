import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ExecutionPreflightKind = {
  AZURE_CLI: "azure-cli",
} as const;
export type ExecutionPreflightKind =
  (typeof ExecutionPreflightKind)[keyof typeof ExecutionPreflightKind];

export type AzureCliPreflightRequirement = {
  kind: typeof ExecutionPreflightKind.AZURE_CLI;
  subscriptionId: string;
  tenantId?: string;
};

export type ExecutionPreflightRequirement = AzureCliPreflightRequirement;

export type ExecutionPreflightCheck = {
  kind: ExecutionPreflightKind;
  accepted: boolean;
  summary: string;
  context?: Record<string, string>;
};

export type ExecutionPreflightReport = {
  accepted: boolean;
  checkedAt: string;
  checks: ExecutionPreflightCheck[];
};

export type ExecutionCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
};

export type ExecutionCommandRunner = {
  run(command: string, args: string[], cwd: string): Promise<ExecutionCommandResult>;
};

export class LocalExecutionCommandRunner implements ExecutionCommandRunner {
  async run(command: string, args: string[], cwd: string): Promise<ExecutionCommandResult> {
    try {
      const result = await execFileAsync(command, args, {
        cwd,
        encoding: "utf8",
      });
      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (isExecFileError(error)) {
        return {
          exitCode: typeof error.code === "number" ? error.code : null,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
          ...(typeof error.code === "string" ? { errorCode: error.code } : {}),
        };
      }
      throw error;
    }
  }
}

export async function runExecutionPreflight(input: {
  requirements: ExecutionPreflightRequirement[];
  workspacePath: string;
  runner: ExecutionCommandRunner;
  now?: Date;
}): Promise<ExecutionPreflightReport> {
  const checks: ExecutionPreflightCheck[] = [];
  for (const requirement of input.requirements) {
    switch (requirement.kind) {
      case ExecutionPreflightKind.AZURE_CLI:
        checks.push(await checkAzureCli(requirement, input.workspacePath, input.runner));
    }
  }
  return {
    accepted: checks.every((check) => check.accepted),
    checkedAt: (input.now ?? new Date()).toISOString(),
    checks,
  };
}

export function assertExecutionPreflight(report: ExecutionPreflightReport): void {
  if (!report.accepted) {
    throw new Error(
      `Execution preflight failed: ${report.checks
        .filter((check) => !check.accepted)
        .map((check) => check.summary)
        .join("; ")}`,
    );
  }
}

async function checkAzureCli(
  requirement: AzureCliPreflightRequirement,
  workspacePath: string,
  runner: ExecutionCommandRunner,
): Promise<ExecutionPreflightCheck> {
  const result = await runner.run("az", ["account", "show", "--output", "json"], workspacePath);
  if (result.exitCode !== 0) {
    if (result.errorCode === "ENOENT") {
      return {
        kind: requirement.kind,
        accepted: false,
        summary: "Azure CLI is not installed or not available on PATH.",
      };
    }
    return {
      kind: requirement.kind,
      accepted: false,
      summary: "Azure CLI is not authenticated.",
    };
  }
  let account: Record<string, unknown>;
  try {
    account = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      kind: requirement.kind,
      accepted: false,
      summary: "Azure CLI returned invalid account data.",
    };
  }
  const subscriptionId = readNonEmptyString(account.id);
  const tenantId = readNonEmptyString(account.tenantId);
  if (subscriptionId !== requirement.subscriptionId) {
    return {
      kind: requirement.kind,
      accepted: false,
      summary: `Azure CLI subscription mismatch; expected ${requirement.subscriptionId}, received ${subscriptionId ?? "none"}.`,
      context: {
        expectedSubscriptionId: requirement.subscriptionId,
        actualSubscriptionId: subscriptionId ?? "",
      },
    };
  }
  if (requirement.tenantId && tenantId !== requirement.tenantId) {
    return {
      kind: requirement.kind,
      accepted: false,
      summary: `Azure CLI tenant mismatch; expected ${requirement.tenantId}, received ${tenantId ?? "none"}.`,
      context: {
        expectedTenantId: requirement.tenantId,
        actualTenantId: tenantId ?? "",
      },
    };
  }
  return {
    kind: requirement.kind,
    accepted: true,
    summary: "Azure CLI is authenticated and pinned to the required subscription.",
    context: {
      subscriptionId,
      ...(tenantId ? { tenantId } : {}),
    },
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type ExecFileError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
};

function isExecFileError(error: unknown): error is ExecFileError {
  return error instanceof Error;
}
