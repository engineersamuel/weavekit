import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSubmindOperatingSkill,
  submindOperatingSkillPath,
} from "../../src/submind/instructions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("submind operating instructions", () => {
  it("loads the repository skill as the canonical instruction source", async () => {
    const instructions = await loadSubmindOperatingSkill();

    expect(instructions).toContain("name: mastermind-submind");
    expect(instructions).toContain("trellage list --json");
    expect(instructions).toContain("trx list --json");
    expect(instructions).not.toContain("trx -i");
  });

  it("loads the packaged skill relative to a compiled module", async () => {
    const root = await mkdtemp(join(tmpdir(), "submind-instructions-"));
    directories.push(root);
    const skillsDirectory = join(root, "dist", ".github", "skills");
    const skillPath = submindOperatingSkillPath(skillsDirectory);
    await mkdir(join(skillsDirectory, "mastermind-submind"), { recursive: true });
    await writeFile(skillPath, "packaged instructions\n");
    const moduleUrl = pathToFileURL(join(root, "dist", "src", "submind", "instructions.js")).href;

    await expect(loadSubmindOperatingSkill(moduleUrl)).resolves.toBe("packaged instructions\n");
  });
});
