import { BeadsCliWorkQueue } from "./beads.js";
import {
  CreateWorkItemInputSchema,
  ReadyWorkFilterSchema,
  WorkDependencySchema,
  WorkItemTypeSchema,
  type CreateWorkItemInput,
  type ReadyWorkFilter,
} from "./schema.js";
import type { WorkQueueBackend } from "./backend.js";

export type WorkQueueCliArgs =
  | { command: "ready"; cwd: string; filter: ReadyWorkFilter }
  | { command: "show"; cwd: string; id: string }
  | { command: "claim"; cwd: string; id: string }
  | { command: "create"; cwd: string; input: CreateWorkItemInput }
  | { command: "close"; cwd: string; id: string; reason: string }
  | { command: "sync"; cwd: string };

export type WorkQueueCliDeps = {
  backend?: WorkQueueBackend;
  write?: (text: string) => void;
};

function readValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function readAllValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) values.push(argv[i + 1]!);
  }
  return values;
}

function parseNumberFlag(argv: string[], flag: string): number | undefined {
  const value = readValue(argv, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid ${flag} value. Expected an integer.`);
  return parsed;
}

function parseDependency(value: string) {
  const separator = value.indexOf(":");
  if (separator === -1) throw new Error(`Invalid dependency ${value}. Expected <type>:<id>.`);
  return WorkDependencySchema.parse({
    type: value.slice(0, separator),
    id: value.slice(separator + 1),
  });
}

export function parseWorkQueueCliArgs(argv: string[]): WorkQueueCliArgs {
  const [command] = argv;
  const cwd = readValue(argv, "--cwd") ?? process.cwd();

  if (command === "ready") {
    return {
      command,
      cwd,
      filter: ReadyWorkFilterSchema.parse({
        priority: parseNumberFlag(argv, "--priority"),
        assignee: readValue(argv, "--assignee"),
        limit: parseNumberFlag(argv, "--limit"),
      }),
    };
  }

  if (command === "show" || command === "claim") {
    const id = argv[1];
    if (!id) throw new Error(`Usage: weavekit work ${command} <id>`);
    return { command, cwd, id };
  }

  if (command === "create") {
    const title = readValue(argv, "--title");
    if (!title) throw new Error("Usage: weavekit work create --title <title>");
    const type = readValue(argv, "--type") ?? "task";
    return {
      command,
      cwd,
      input: CreateWorkItemInputSchema.parse({
        title,
        description: readValue(argv, "--description"),
        priority: parseNumberFlag(argv, "--priority") ?? 2,
        type: WorkItemTypeSchema.parse(type),
        labels: readAllValues(argv, "--label"),
        dependencies: readAllValues(argv, "--dep").map(parseDependency),
      }),
    };
  }

  if (command === "close") {
    const id = argv[1];
    const reason = readValue(argv, "--reason");
    if (!id || !reason) throw new Error("Usage: weavekit work close <id> --reason <reason>");
    return { command, cwd, id, reason };
  }

  if (command === "sync") {
    return { command, cwd };
  }

  throw new Error("Usage: weavekit work <ready|show|claim|create|close|sync>");
}

export async function runWorkQueueCli(argv: string[], deps: WorkQueueCliDeps = {}): Promise<void> {
  const args = parseWorkQueueCliArgs(argv);
  const backend = deps.backend ?? new BeadsCliWorkQueue({ cwd: args.cwd });
  const write = deps.write ?? ((text) => process.stdout.write(text));

  if (args.command === "ready") {
    write(`${JSON.stringify(await backend.ready(args.filter), null, 2)}\n`);
    return;
  }

  if (args.command === "show") {
    write(`${JSON.stringify(await backend.show(args.id), null, 2)}\n`);
    return;
  }

  if (args.command === "claim") {
    write(`${JSON.stringify(await backend.claim(args.id), null, 2)}\n`);
    return;
  }

  if (args.command === "create") {
    write(`${JSON.stringify(await backend.create(args.input), null, 2)}\n`);
    return;
  }

  if (args.command === "close") {
    write(`${JSON.stringify(await backend.close(args.id, { reason: args.reason }), null, 2)}\n`);
    return;
  }

  await backend.sync();
  write("{\"synced\":true}\n");
}
