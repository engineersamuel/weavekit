import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runConfiguredHarnessCommand(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<string> {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  const invocation = [input.command, ...input.args].map(shellQuote).join(" ");
  const { stdout } = await execFileAsync(shell, ["-lic", invocation], {
    cwd: input.cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
