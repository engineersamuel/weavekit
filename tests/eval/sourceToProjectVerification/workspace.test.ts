import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectVerificationWorkspaceMutationError,
  withProjectVerificationWorkspace,
} from "../../../src/eval/sourceToProjectVerification/workspace.js";

describe("source-to-project verification workspace", () => {
  it("copies the controlled project and source into an isolated workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-source-"));
    const projectDir = join(root, "project");
    const sourcePath = join(root, "source.md");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDir));
    await writeFile(join(projectDir, "app.ts"), "export const value = 1;\n", "utf8");
    await writeFile(sourcePath, "# Best practices\n", "utf8");

    const observed = await withProjectVerificationWorkspace(
      { projectDir, sourcePath },
      async (workspace) => ({
        project: await readFile(join(workspace.projectDir, "app.ts"), "utf8"),
        source: await readFile(workspace.sourcePath, "utf8"),
      }),
    );

    expect(observed).toEqual({
      project: "export const value = 1;\n",
      source: "# Best practices\n",
    });
  });

  it("fails closed when a provider modifies the copied target project", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-mutation-"));
    const projectDir = join(root, "project");
    const sourcePath = join(root, "source.md");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDir));
    await writeFile(join(projectDir, "app.ts"), "export const value = 1;\n", "utf8");
    await writeFile(sourcePath, "# Best practices\n", "utf8");

    const mutation = await withProjectVerificationWorkspace(
      { projectDir, sourcePath },
      async (workspace) => {
        await writeFile(join(workspace.projectDir, "app.ts"), "export const value = 2;\n", "utf8");
        return "plan produced";
      },
    ).catch((error: unknown) => error);

    expect(mutation).toBeInstanceOf(ProjectVerificationWorkspaceMutationError);
    expect(mutation).toMatchObject({ result: "plan produced", changedFiles: ["app.ts"] });
    expect((mutation as Error).message).toMatch(/modified the controlled target project/i);

    expect(await readFile(join(projectDir, "app.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("keeps an in-tree relative symlink isolated inside the copied project", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-safe-link-"));
    const projectDir = join(root, "project");
    const sourcePath = join(root, "source.md");
    await mkdir(join(projectDir, "data"), { recursive: true });
    await writeFile(join(projectDir, "data", "value.txt"), "original\n", "utf8");
    await symlink("data/value.txt", join(projectDir, "value.txt"));
    await writeFile(sourcePath, "# Best practices\n", "utf8");
    let copiedLinkTarget = "";

    const mutation = await withProjectVerificationWorkspace(
      { projectDir, sourcePath },
      async (workspace) => {
        const copiedLink = join(workspace.projectDir, "value.txt");
        copiedLinkTarget = await readlink(copiedLink);
        await writeFile(copiedLink, "changed\n", "utf8");
        return "plan produced";
      },
    ).catch((error: unknown) => error);

    expect(copiedLinkTarget).toBe("data/value.txt");
    expect(mutation).toBeInstanceOf(ProjectVerificationWorkspaceMutationError);
    expect(mutation).toMatchObject({
      result: "plan produced",
      changedFiles: ["data/value.txt"],
    });
    expect(await readFile(join(projectDir, "data", "value.txt"), "utf8")).toBe("original\n");
  });

  it.each(["absolute", "escaping-relative"] as const)(
    "rejects an %s source-project symlink before provider execution",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-unsafe-link-"));
      const projectDir = join(root, "project");
      const sourcePath = join(root, "source.md");
      const outsidePath = join(root, "outside.txt");
      await mkdir(projectDir);
      await writeFile(outsidePath, "outside\n", "utf8");
      await symlink(
        kind === "absolute" ? outsidePath : "../outside.txt",
        join(projectDir, "escape.txt"),
      );
      await writeFile(sourcePath, "# Best practices\n", "utf8");
      let providerExecuted = false;

      const rejection = await withProjectVerificationWorkspace(
        { projectDir, sourcePath },
        async () => {
          providerExecuted = true;
          return "plan produced";
        },
      ).catch((error: unknown) => error);

      expect(providerExecuted).toBe(false);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/unsafe source-project symlink.*escape\.txt/i);
    },
  );

  it("detects replacement of a copied symlink target", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-link-change-"));
    const projectDir = join(root, "project");
    const sourcePath = join(root, "source.md");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "first.txt"), "first\n", "utf8");
    await writeFile(join(projectDir, "second.txt"), "second\n", "utf8");
    await symlink("first.txt", join(projectDir, "current.txt"));
    await writeFile(sourcePath, "# Best practices\n", "utf8");

    const mutation = await withProjectVerificationWorkspace(
      { projectDir, sourcePath },
      async (workspace) => {
        const linkPath = join(workspace.projectDir, "current.txt");
        await unlink(linkPath);
        await symlink("second.txt", linkPath);
        return "plan produced";
      },
    ).catch((error: unknown) => error);

    expect(mutation).toBeInstanceOf(ProjectVerificationWorkspaceMutationError);
    expect(mutation).toMatchObject({ result: "plan produced", changedFiles: ["current.txt"] });
  });

  it.each(["deleted", "replaced"] as const)(
    "preserves the result when the copied project root is %s",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-root-change-"));
      const projectDir = join(root, "project");
      const sourcePath = join(root, "source.md");
      await mkdir(projectDir);
      await writeFile(join(projectDir, "app.ts"), "export const value = 1;\n", "utf8");
      await writeFile(sourcePath, "# Best practices\n", "utf8");

      const mutation = await withProjectVerificationWorkspace(
        { projectDir, sourcePath },
        async (workspace) => {
          await rm(workspace.projectDir, { recursive: true });
          if (action === "replaced") await writeFile(workspace.projectDir, "replacement\n", "utf8");
          return "plan produced";
        },
      ).catch((error: unknown) => error);

      expect(mutation).toBeInstanceOf(ProjectVerificationWorkspaceMutationError);
      expect(mutation).toMatchObject({
        result: "plan produced",
        changedFiles: ["<project-root>"],
      });
      expect((mutation as Error).message).toMatch(
        /modified.*controlled target project.*project-root/i,
      );
    },
  );
});
