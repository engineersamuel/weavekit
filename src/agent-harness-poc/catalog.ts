import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Trace } from "./trace.js";

export type SkillDescriptor = {
  id: string;
  directory: string;
  summary: string;
  bodyPath: string;
};

export class SkillCatalog {
  private readonly root: string;
  private readonly trace: Trace;

  constructor(root: string, trace: Trace) {
    this.root = path.resolve(root);
    this.trace = trace;
  }

  discover(): SkillDescriptor[] {
    this.trace.push("catalog.discover.start", `scanning ${this.root}`);
    if (!existsSync(this.root)) {
      throw new Error(`Skill catalog does not exist: ${this.root}`);
    }

    const results: SkillDescriptor[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.root, entry.name);
      const descriptorPath = path.join(directory, "skill.json");
      if (!existsSync(descriptorPath)) continue;

      const parsed: unknown = JSON.parse(readFileSync(descriptorPath, "utf8"));
      if (!isDescriptorFile(parsed)) {
        throw new Error(`Invalid skill descriptor: ${descriptorPath}`);
      }
      const bodyPath = resolveContainedPath(directory, parsed.body);
      const descriptor = {
        id: parsed.id,
        summary: parsed.summary,
        directory,
        bodyPath,
      };
      results.push(descriptor);
      this.trace.push("catalog.discovered", `found ${descriptor.id}`, {
        summary: descriptor.summary,
      });
    }

    this.trace.push("catalog.discover.end", `found ${results.length} skills`);
    return results;
  }

  loadSkillBody(descriptor: SkillDescriptor): string {
    this.trace.push("catalog.load.start", `loading ${descriptor.id}`);
    const bodyPath = resolveContainedPath(descriptor.directory, descriptor.bodyPath);
    if (!existsSync(bodyPath)) {
      this.trace.push("catalog.load.fail", `no body for ${descriptor.id}`);
      throw new Error(`Skill body not found: ${bodyPath}`);
    }
    const content = readFileSync(bodyPath, "utf8");
    this.trace.push("catalog.load.end", `loaded ${descriptor.id}`);
    return content;
  }
}

type DescriptorFile = {
  id: string;
  summary: string;
  body: string;
};

function isDescriptorFile(value: unknown): value is DescriptorFile {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;
  return (
    typeof descriptor.id === "string" &&
    descriptor.id.length > 0 &&
    typeof descriptor.summary === "string" &&
    descriptor.summary.length > 0 &&
    typeof descriptor.body === "string" &&
    descriptor.body.length > 0
  );
}

function resolveContainedPath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes skill directory: ${candidate}`);
  }
  return resolvedCandidate;
}
