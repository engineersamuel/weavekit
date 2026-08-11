import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubmindStore } from "../../src/submind-poc/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SubmindStore", () => {
  it("serializes concurrent append-only event receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "submind-store-"));
    directories.push(directory);
    const stores = [new SubmindStore(directory), new SubmindStore(directory)];

    await Promise.all(
      stores.map((store, index) =>
        store.appendEvent({
          runId: "run-one",
          type: "receipt",
          timestamp: "2026-08-06T00:00:00.000Z",
          data: { index },
        }),
      ),
    );

    expect((await stores[0]!.readEvents()).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("preserves a valid final JSONL event that lacks a newline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "submind-store-"));
    directories.push(directory);
    const store = new SubmindStore(directory);
    const first = {
      schemaVersion: 1,
      sequence: 1,
      runId: "run-one",
      type: "receipt",
      timestamp: "2026-08-06T00:00:00.000Z",
      data: { operation: "first" },
    } as const;
    await writeFile(store.eventsPath, JSON.stringify(first), "utf8");

    await store.appendEvent({
      runId: "run-one",
      type: "receipt",
      timestamp: "2026-08-06T00:00:01.000Z",
      data: { operation: "second" },
    });

    expect((await store.readEvents()).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });
});
