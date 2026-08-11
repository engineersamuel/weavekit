import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SubmindEventSchema,
  SubmindManifestSchema,
  SubmindRunStateSchema,
  type SubmindEvent,
  type SubmindManifest,
  type SubmindRunState,
} from "./contracts.js";

export class SubmindStore {
  readonly statePath: string;
  readonly eventsPath: string;
  readonly manifestPath: string;

  constructor(readonly runDirectory: string) {
    this.statePath = join(runDirectory, "state.json");
    this.eventsPath = join(runDirectory, "events.jsonl");
    this.manifestPath = join(runDirectory, "manifest.json");
  }

  async initialize(state: SubmindRunState): Promise<void> {
    await mkdir(this.runDirectory, { recursive: true });
    await this.writeState(state);
  }

  async readState(): Promise<SubmindRunState> {
    return SubmindRunStateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")));
  }

  async writeState(state: SubmindRunState): Promise<void> {
    await atomicJson(this.statePath, SubmindRunStateSchema.parse(state));
  }

  async updateState(update: (state: SubmindRunState) => SubmindRunState): Promise<SubmindRunState> {
    const next = SubmindRunStateSchema.parse(update(await this.readState()));
    await this.writeState(next);
    return next;
  }

  async appendEvent(
    event: Omit<SubmindEvent, "schemaVersion" | "sequence">,
  ): Promise<SubmindEvent> {
    return withFileLock(`${this.eventsPath}.lock`, async () => {
      await repairIncompleteFinalEvent(this.eventsPath);
      const sequence = ((await this.readEvents()).at(-1)?.sequence ?? 0) + 1;
      const persisted = SubmindEventSchema.parse({
        schemaVersion: 1,
        sequence,
        ...event,
      });
      await mkdir(dirname(this.eventsPath), { recursive: true });
      await appendFile(this.eventsPath, `${JSON.stringify(persisted)}\n`, "utf8");
      return persisted;
    });
  }

  async readEvents(): Promise<SubmindEvent[]> {
    try {
      const raw = await readFile(this.eventsPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const events: SubmindEvent[] = [];
      for (const [index, line] of lines.entries()) {
        try {
          events.push(SubmindEventSchema.parse(JSON.parse(line)));
        } catch (error) {
          if (index === lines.length - 1 && !raw.endsWith("\n")) break;
          throw error;
        }
      }
      return events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async writeManifest(manifest: SubmindManifest): Promise<void> {
    await atomicJson(this.manifestPath, SubmindManifestSchema.parse(manifest));
  }

  async readManifest(): Promise<SubmindManifest> {
    return SubmindManifestSchema.parse(JSON.parse(await readFile(this.manifestPath, "utf8")));
  }
}

async function repairIncompleteFinalEvent(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw || raw.endsWith("\n")) return;
    const finalLine = raw.slice(raw.lastIndexOf("\n") + 1);
    const parsed = SubmindEventSchema.safeParse(JSON.parse(finalLine));
    if (parsed.success) {
      await appendFile(path, "\n", "utf8");
      return;
    }
    await truncate(path, raw.lastIndexOf("\n") + 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof SyntaxError) {
      const raw = await readFile(path, "utf8");
      await truncate(path, raw.lastIndexOf("\n") + 1);
      return;
    }
    throw error;
  }
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - (await stat(path)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age > 30_000) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out acquiring submind event lock.");
      await delay(10);
      continue;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(path).catch(() => undefined);
    }
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}
