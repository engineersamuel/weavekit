import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { b } from "../generated/baml_client/index.js";
import { validateSkillReference } from "./skills.js";
import type { EntityValidationError, WorkflowEntityManifest } from "./schema.js";

export function getGeneratedBamlFunctionNames(): Set<string> {
  const client = b as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(b) as Record<string, unknown> | null;
  const keys = new Set([
    ...Object.keys(client),
    ...(prototype ? Object.getOwnPropertyNames(prototype) : []),
  ]);
  keys.delete("constructor");
  return new Set(
    [...keys].filter(
      (key) => typeof client[key] === "function" || typeof prototype?.[key] === "function",
    ),
  );
}

function addUnknownBamlFunctionError(args: {
  errors: EntityValidationError[];
  functionName: string;
  filePath: string;
  entityId: string;
  fieldPath: string;
  bamlFunctions: Set<string>;
}): void {
  if (args.bamlFunctions.has(args.functionName)) {
    return;
  }
  args.errors.push({
    code: "entity.baml_function_unknown",
    filePath: args.filePath,
    entityId: args.entityId,
    fieldPath: args.fieldPath,
    message: `Referenced BAML function ${args.functionName} does not exist in the generated client.`,
    repairHint: "Use a generated BAML function name or run nub run baml-generate after adding it.",
    value: args.functionName,
  });
}

function validatePromptRef(args: {
  errors: EntityValidationError[];
  manifest: WorkflowEntityManifest;
  filePath: string;
  absolutePath: string;
}): void {
  if (args.manifest.execution.mode !== "harness_then_baml") {
    return;
  }

  const expected = `./${args.manifest.id}.md`;
  const promptRef = args.manifest.execution.promptRef;
  if (promptRef !== expected) {
    args.errors.push({
      code: "entity.prompt_ref_invalid",
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "execution.promptRef",
      message: `Prompt reference must be ${expected}.`,
      repairHint: `Set execution.promptRef to ${expected} and keep prompt Markdown beside the manifest.`,
      value: promptRef,
    });
  }

  const manifestDir = dirname(args.absolutePath);
  const promptPath = normalize(join(manifestDir, promptRef));
  if (isAbsolute(promptRef) || relative(manifestDir, promptPath).startsWith("..")) {
    args.errors.push({
      code: "entity.prompt_ref_outside_directory",
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "execution.promptRef",
      message: "Prompt reference must resolve inside the manifest directory.",
      repairHint: `Use ./${args.manifest.id}.md as a sibling Markdown prompt.`,
      value: promptRef,
    });
    return;
  }

  if (!existsSync(promptPath)) {
    args.errors.push({
      code: "entity.prompt_missing",
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "execution.promptRef",
      message: `Prompt Markdown ${promptRef} is missing.`,
      repairHint: `Create ${expected} beside the manifest with non-empty prompt prose.`,
      value: promptRef,
    });
    return;
  }

  if (readFileSync(promptPath, "utf8").trim().length === 0) {
    args.errors.push({
      code: "entity.prompt_empty",
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "execution.promptRef",
      message: `Prompt Markdown ${promptRef} is empty.`,
      repairHint: "Add non-empty prompt prose to the sibling Markdown file.",
      value: promptRef,
    });
  }
}

export function validateManifestSemantics(args: {
  manifest: WorkflowEntityManifest;
  filePath: string;
  absolutePath: string;
  repoRoot: string;
  bamlFunctions?: Set<string>;
}): EntityValidationError[] {
  const errors: EntityValidationError[] = [];
  const bamlFunctions = args.bamlFunctions ?? getGeneratedBamlFunctionNames();
  const execution = args.manifest.execution;

  if (execution.mode === "baml_direct") {
    addUnknownBamlFunctionError({
      errors,
      functionName: execution.bamlFunction,
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "execution.bamlFunction",
      bamlFunctions,
    });
  } else {
    validatePromptRef({ errors, ...args });
    addUnknownBamlFunctionError({
      errors,
      functionName: execution.output.normalizeWithBamlFunction,
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "execution.output.normalizeWithBamlFunction",
      bamlFunctions,
    });
  }

  if (args.manifest.capabilities && "mcps" in args.manifest.capabilities) {
    errors.push({
      code: "entity.mcps_not_supported_v1",
      filePath: args.filePath,
      entityId: args.manifest.id,
      fieldPath: "capabilities.mcps",
      message: "MCP capability scoping is not supported in v1 entity manifests.",
      repairHint: "Remove capabilities.mcps; v1 cannot prove per-session MCP scoping yet.",
      value: args.manifest.capabilities.mcps,
    });
  }

  for (const skillName of args.manifest.capabilities?.skills ?? []) {
    const result = validateSkillReference(skillName, args.repoRoot);
    errors.push(
      ...result.errors.map((error) => ({
        ...error,
        filePath: args.filePath,
        entityId: args.manifest.id,
      })),
    );
  }

  return errors;
}
