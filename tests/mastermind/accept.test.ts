import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAcceptanceComment,
  persistAcceptedWorkspace,
} from "../../src/mastermind/codeReview/accept.js";
import type { ExecutionAttachmentTarget } from "../../src/mastermind/store/store.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Mastermind acceptance handoff", () => {
  it("persists greenfield output and points the handoff at the durable repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastermind-accept-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "temporary-worktree");
    const durable = join(root, "prototype");
    await Promise.all([
      mkdir(join(checkout, ".weavekit", "evidence"), { recursive: true }),
      mkdir(durable, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(checkout, "README.md"), "Run the prototype.\n"),
      writeFile(join(checkout, ".gitignore"), ".azure/\n"),
      writeFile(join(checkout, ".weavekit", "evidence", "test.txt"), "passed\n"),
      writeFile(join(checkout, ".weavekit", "runtime.log"), "transient\n"),
    ]);
    await mkdir(join(checkout, ".azure"), { recursive: true });
    await writeFile(join(checkout, ".azure", "config.json"), "{}\n");
    await execFileAsync("git", ["init"], { cwd: checkout });
    const target = {
      attempt: {
        id: "attempt-one",
        workspace: {
          kind: "greenfield-repository-worktree",
          checkoutPath: checkout,
          sourceRepositoryPath: durable,
        },
        result: {
          artifactPaths: ["README.md", ".weavekit/evidence/test.txt"],
          verification: [],
        },
      },
    } as unknown as ExecutionAttachmentTarget;

    await persistAcceptedWorkspace(target);

    await expect(readFile(join(durable, "README.md"), "utf8")).resolves.toBe(
      "Run the prototype.\n",
    );
    await expect(
      readFile(join(durable, ".weavekit", "evidence", "test.txt"), "utf8"),
    ).resolves.toBe("passed\n");
    await expect(readFile(join(durable, ".weavekit", "runtime.log"), "utf8")).rejects.toThrow();
    await expect(readFile(join(durable, ".azure", "config.json"), "utf8")).rejects.toThrow();
    expect(buildAcceptanceComment("<!-- marker -->", target)).toContain(`cd '${durable}'`);
  });
});
