import {
  getPersona as getEntityPersona,
  listPersonas as listEntityPersonas,
} from "../entities/index.js";
import { PersonaDefinitionSchema, type PersonaDefinition } from "./schema.js";

export interface PersonaRegistry {
  getPersona(id: string): PersonaDefinition;
  listPersonas(): PersonaDefinition[];
}

export function buildRegistry(repoRoot = process.cwd()): PersonaRegistry {
  function getPersona(id: string): PersonaDefinition {
    return PersonaDefinitionSchema.parse(getEntityPersona(id, repoRoot));
  }

  function listPersonas(): PersonaDefinition[] {
    return listEntityPersonas(repoRoot).map((persona) => PersonaDefinitionSchema.parse(persona));
  }

  return { getPersona, listPersonas };
}

export const defaultRegistry: PersonaRegistry = buildRegistry();

export const getPersona = (id: string): PersonaDefinition => defaultRegistry.getPersona(id);
export const listPersonas = (): PersonaDefinition[] => defaultRegistry.listPersonas();
