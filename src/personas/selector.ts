import { b, type PersonaChoiceCandidate, type PersonaSelectionRequest } from "../generated/baml_client/index.js";
import { listPersonas } from "./registry.js";
import type { PersonaDefinition, PersonaSet } from "./schema.js";

const DEFAULT_MIN_PERSONAS = 2;
const DEFAULT_MAX_PERSONAS = 4;

export type PersonaSelectionInput = {
  workflowName: string;
  workflowPurpose: string;
  taskPrompt: string;
  context?: string[];
  constraints?: string[];
  roundNumber?: number;
  roundFocus?: string;
  previousSelectionIds?: string[];
  previousRoundSignals?: string[];
  candidatePersonas?: PersonaDefinition[];
  minPersonas?: number;
  maxPersonas?: number;
};

export type PersonaSelectionResult = {
  personaSet: PersonaSet;
  rationale: string;
};

export type PersonaSelectorEvent = {
  type: "persona.selector.failed";
  workflowName: string;
  roundNumber?: number;
  error: string;
};

export interface PersonaSelector {
  choosePersonas(input: PersonaSelectionInput): Promise<PersonaSelectionResult>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitSelectorFailureEvent(
  onEvent: ((event: PersonaSelectorEvent) => void) | undefined,
  input: PersonaSelectionInput,
  error: unknown,
): void {
  if (!onEvent) return;
  try {
    onEvent({
      type: "persona.selector.failed",
      workflowName: input.workflowName,
      roundNumber: input.roundNumber,
      error: toErrorMessage(error),
    });
  } catch {
    // Selector failures should preserve original error semantics even if observers fail.
  }
}

function toCandidateCard(persona: PersonaDefinition): PersonaChoiceCandidate {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    archetype: persona.archetype,
    tags: [...persona.tags],
    modes: [...persona.modes],
    selectionHints: [...persona.selectionHints],
    selectionAntiHints: [...persona.selectionAntiHints],
  };
}

function resolveSelectionRange(
  input: PersonaSelectionInput,
  defaults: { minPersonas?: number; maxPersonas?: number },
): { minPersonas: number; maxPersonas: number } {
  const minPersonas = input.minPersonas ?? defaults.minPersonas ?? DEFAULT_MIN_PERSONAS;
  const maxPersonas = input.maxPersonas ?? defaults.maxPersonas ?? DEFAULT_MAX_PERSONAS;

  if (!Number.isInteger(minPersonas) || minPersonas < 1) {
    throw new Error(`Persona chooser minimum must be a positive integer; received ${String(minPersonas)}.`);
  }

  if (!Number.isInteger(maxPersonas) || maxPersonas < minPersonas) {
    throw new Error(
      `Persona chooser maximum must be an integer greater than or equal to min (${minPersonas}); received ${String(maxPersonas)}.`,
    );
  }

  return { minPersonas, maxPersonas };
}

function resolveSelectedPersonas(
  ids: string[],
  candidates: PersonaDefinition[],
  minPersonas: number,
  maxPersonas: number,
): PersonaDefinition[] {
  const byId = new Map(candidates.map((persona) => [persona.id, persona]));
  const seen = new Set<string>();
  const selected: PersonaDefinition[] = [];

  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Persona chooser returned duplicate persona id "${id}".`);
    }
    seen.add(id);
    const persona = byId.get(id);
    if (!persona) {
      throw new Error(`Persona chooser returned unknown persona id "${id}".`);
    }
    selected.push(persona);
  }

  if (selected.length < minPersonas || selected.length > maxPersonas) {
    throw new Error(`Persona chooser selected ${selected.length} personas; expected ${minPersonas}-${maxPersonas}.`);
  }

  return selected.map((persona) => structuredClone(persona));
}

function resolveCandidates(input: PersonaSelectionInput, defaults?: PersonaDefinition[]): PersonaDefinition[] {
  const candidates = input.candidatePersonas ?? defaults ?? listPersonas();
  return candidates.map((persona) => structuredClone(persona));
}

export function createBamlPersonaSelector(args: {
  bamlClient?: Pick<typeof b, "ChoosePersonasForTask">;
  candidatePersonas?: PersonaDefinition[];
  minPersonas?: number;
  maxPersonas?: number;
  onEvent?: (event: PersonaSelectorEvent) => void;
} = {}): PersonaSelector {
  const bamlClient = args.bamlClient ?? b;

  return {
    async choosePersonas(input: PersonaSelectionInput): Promise<PersonaSelectionResult> {
      try {
        const candidates = resolveCandidates(input, args.candidatePersonas);
        const { minPersonas, maxPersonas } = resolveSelectionRange(input, args);

        if (candidates.length < minPersonas) {
          throw new Error(
            `Persona chooser requires at least ${minPersonas} candidates, but only ${candidates.length} were provided.`,
          );
        }

        const request: PersonaSelectionRequest = {
          workflowName: input.workflowName,
          workflowPurpose: input.workflowPurpose,
          taskPrompt: input.taskPrompt,
          context: input.context ?? [],
          constraints: input.constraints ?? [],
          roundNumber: input.roundNumber,
          roundFocus: input.roundFocus,
          previousSelectionIds: input.previousSelectionIds ?? [],
          previousRoundSignals: input.previousRoundSignals ?? [],
          minPersonas,
          maxPersonas,
          candidates: candidates.map(toCandidateCard),
        };

        const selection = await bamlClient.ChoosePersonasForTask(request);
        const selectedPersonas = resolveSelectedPersonas(selection.personaIds, candidates, minPersonas, maxPersonas);

        return {
          personaSet: {
            name: "selected",
            personas: selectedPersonas,
          },
          rationale: selection.rationale,
        };
      } catch (error) {
        emitSelectorFailureEvent(args.onEvent, input, error);
        throw error;
      }
    },
  };
}

export function createStaticPersonaSelector(personaSet: PersonaSet): PersonaSelector {
  return {
    async choosePersonas(): Promise<PersonaSelectionResult> {
      return {
        personaSet: structuredClone(personaSet),
        rationale: `Static persona selector returned persona set "${personaSet.name}".`,
      };
    },
  };
}
