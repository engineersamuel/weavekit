import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
  PersonaDefinitionSchema,
  PersonaSetSchema,
  type PersonaDefinition,
  type PersonaSet,
} from "./schema.js";

const SETS_FILE = "sets.toml";

export interface PersonaRegistry {
  getPersona(id: string): PersonaDefinition;
  getPersonaSet(name: string): PersonaSet;
  listPersonas(): PersonaDefinition[];
  listPersonaSets(): string[];
  resolvePersonaSet(set?: PersonaSet): PersonaSet;
  resolvePersonaSetByName(name?: string): PersonaSet;
}

/**
 * Locates the personas/ content directory. Honors WEAVEKIT_PERSONAS_DIR, otherwise
 * searches upward from this module for an ancestor personas/ dir containing sets.toml.
 * Upward search (not a fixed relative path) keeps resolution correct in both the dev
 * src/ layout and the built dist/src/ layout, regardless of process cwd.
 */
export function resolvePersonasDir(): string {
  const override = process.env.WEAVEKIT_PERSONAS_DIR;
  if (override) {
    return override;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "personas");
    if (existsSync(join(candidate, SETS_FILE))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(
    `Could not locate a personas/ directory containing ${SETS_FILE} by searching upward from ` +
      `${fileURLToPath(import.meta.url)}. Set WEAVEKIT_PERSONAS_DIR to override.`,
  );
}

function loadPersonas(dir: string): Map<string, PersonaDefinition> {
  const byId = new Map<string, PersonaDefinition>();
  const files = readdirSync(dir).filter((file) => file.endsWith(".toml") && file !== SETS_FILE);

  for (const file of files) {
    const raw = parseToml(readFileSync(join(dir, file), "utf8"));
    const persona = PersonaDefinitionSchema.parse(raw);
    if (byId.has(persona.id)) {
      throw new Error(`Duplicate persona id "${persona.id}" found while loading ${file}.`);
    }
    byId.set(persona.id, persona);
  }

  return byId;
}

function loadSets(dir: string, personasById: Map<string, PersonaDefinition>): Map<string, PersonaSet> {
  const byName = new Map<string, PersonaSet>();
  const rawSets = parseToml(readFileSync(join(dir, SETS_FILE), "utf8")) as {
    sets?: Record<string, { personas?: unknown }>;
  };

  for (const [name, body] of Object.entries(rawSets.sets ?? {})) {
    const ids = Array.isArray(body.personas) ? (body.personas as string[]) : [];
    const personas = ids.map((id) => {
      const persona = personasById.get(id);
      if (!persona) {
        throw new Error(`Persona set "${name}" references unknown persona id "${id}".`);
      }
      return persona;
    });
    byName.set(name, PersonaSetSchema.parse({ name, personas }));
  }

  return byName;
}

export function buildRegistry(dir: string): PersonaRegistry {
  const personasById = loadPersonas(dir);
  const setsByName = loadSets(dir, personasById);

  function getPersona(id: string): PersonaDefinition {
    const persona = personasById.get(id);
    if (!persona) {
      const available = [...personasById.keys()].join(", ");
      throw new Error(`Unknown persona "${id}". Available personas: ${available}.`);
    }
    return persona;
  }

  function getPersonaSet(name: string): PersonaSet {
    const set = setsByName.get(name);
    if (!set) {
      const available = [...setsByName.keys()].join(", ");
      throw new Error(`Unknown persona set "${name}". Available persona sets: ${available}.`);
    }
    return set;
  }

  function listPersonas(): PersonaDefinition[] {
    return [...personasById.values()].map((persona) => structuredClone(persona));
  }

  function listPersonaSets(): string[] {
    return [...setsByName.keys()];
  }

  function resolvePersonaSet(set: PersonaSet = getPersonaSet("default")): PersonaSet {
    return PersonaSetSchema.parse(structuredClone(set));
  }

  function resolvePersonaSetByName(name?: string): PersonaSet {
    if (!name) {
      return resolvePersonaSet(getPersonaSet("default"));
    }
    return resolvePersonaSet(getPersonaSet(name));
  }

  return { getPersona, getPersonaSet, listPersonas, listPersonaSets, resolvePersonaSet, resolvePersonaSetByName };
}

// Eager default registry: sync file I/O at module load preserves the synchronous
// resolvePersonaSetByName contract that runner.ts, the CLI, and the eval council provider rely on.
export const defaultRegistry: PersonaRegistry = buildRegistry(resolvePersonasDir());

export const getPersona = (id: string): PersonaDefinition => defaultRegistry.getPersona(id);
export const getPersonaSet = (name: string): PersonaSet => defaultRegistry.getPersonaSet(name);
export const listPersonas = (): PersonaDefinition[] => defaultRegistry.listPersonas();
export const listPersonaSets = (): string[] => defaultRegistry.listPersonaSets();
export const resolvePersonaSet = (set?: PersonaSet): PersonaSet => defaultRegistry.resolvePersonaSet(set);
export const resolvePersonaSetByName = (name?: string): PersonaSet =>
  defaultRegistry.resolvePersonaSetByName(name);
