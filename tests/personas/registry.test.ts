import { describe, expect, it } from "vitest";
import {
  buildRegistry,
  getPersona,
  getPersonaSet,
  listPersonaSets,
  resolvePersonaSet,
  resolvePersonaSetByName,
  resolvePersonasDir,
} from "../../src/personas/registry.js";

describe("default persona registry", () => {
  it("resolves the default set with the approved personas in order", () => {
    const set = getPersonaSet("default");
    expect(set.name).toBe("default");
    expect(set.personas.map((p) => p.name)).toEqual([
      "Socratic Questioner",
      "Deep Module/DRY Architect",
      "Pragmatic Builder",
      "Skeptic",
    ]);
  });

  it("resolves the strategic set as the four defaults plus the game theorist", () => {
    const set = getPersonaSet("strategic");
    expect(set.personas).toHaveLength(5);
    expect(set.personas.some((p) => p.id === "game-theorist")).toBe(true);
    expect(set.personas.slice(0, 4).map((p) => p.id)).toEqual([
      "socratic",
      "deep-module-dry",
      "pragmatic",
      "skeptic",
    ]);
  });

  it("loads the game-theorist persona with its canonical spec reference", () => {
    const gt = getPersona("game-theorist");
    expect(gt.specRef).toBe("strategic-game-theorist.md");
    expect(gt.prompt).toContain("claims");
    expect(gt.prompt).toContain("risks");
    expect(gt.prompt).toContain("questions");
    expect(gt.prompt).toContain("recommendations");
  });

  it("lists the registered sets", () => {
    expect(listPersonaSets().sort()).toEqual(["default", "strategic"]);
  });

  it("resolvePersonaSetByName defaults to the default set", () => {
    expect(resolvePersonaSetByName(undefined).name).toBe("default");
    expect(resolvePersonaSetByName().personas).toHaveLength(4);
  });

  it("clones on resolve so callers cannot mutate the registry", () => {
    const resolved = resolvePersonaSet(getPersonaSet("default"));
    resolved.personas[0]!.name = "Changed";
    expect(getPersonaSet("default").personas[0]!.name).toBe("Socratic Questioner");
  });

  it("throws a helpful error for an unknown set", () => {
    expect(() => resolvePersonaSetByName("nonexistent")).toThrow(/nonexistent/);
  });

  it("throws a helpful error for an unknown persona", () => {
    expect(() => getPersona("nope")).toThrow(/nope/);
  });
});

describe("registry directory resolution", () => {
  it("honors the WEAVEKIT_PERSONAS_DIR override", () => {
    const prev = process.env.WEAVEKIT_PERSONAS_DIR;
    process.env.WEAVEKIT_PERSONAS_DIR = "/tmp/custom-personas";
    try {
      expect(resolvePersonasDir()).toBe("/tmp/custom-personas");
    } finally {
      if (prev === undefined) delete process.env.WEAVEKIT_PERSONAS_DIR;
      else process.env.WEAVEKIT_PERSONAS_DIR = prev;
    }
  });

  it("buildRegistry loads personas from an explicitly resolved directory", () => {
    const prev = process.env.WEAVEKIT_PERSONAS_DIR;
    delete process.env.WEAVEKIT_PERSONAS_DIR;
    try {
      const registry = buildRegistry(resolvePersonasDir());
      expect(registry.getPersona("socratic").name).toBe("Socratic Questioner");
    } finally {
      if (prev !== undefined) process.env.WEAVEKIT_PERSONAS_DIR = prev;
    }
  });
});
