import { globSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sharedPromptfooRunner = "src/eval/promptfooRunner.ts";

function hasRuntimePromptfooAccess(sourceText: string, path = "fixture.ts"): boolean {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function isPromptfooModuleSpecifier(node: ts.Expression | undefined): boolean {
    return Boolean(node && ts.isStringLiteralLike(node) && node.text === "promptfoo");
  }

  function isRuntimeModuleDeclaration(statement: ts.Statement): boolean {
    if (
      ts.isImportDeclaration(statement) &&
      isPromptfooModuleSpecifier(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      if (!clause || (!clause.isTypeOnly && clause.name)) {
        return true;
      }
      if (clause.isTypeOnly) {
        return false;
      }
      const bindings = clause.namedBindings;
      if (!bindings || ts.isNamespaceImport(bindings)) {
        return true;
      }
      return (
        bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)
      );
    }

    if (
      ts.isExportDeclaration(statement) &&
      isPromptfooModuleSpecifier(statement.moduleSpecifier)
    ) {
      if (statement.isTypeOnly) {
        return false;
      }
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        return true;
      }
      return clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly);
    }

    return false;
  }

  if (source.statements.some(isRuntimeModuleDeclaration)) {
    return true;
  }

  let hasDynamicImport = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isPromptfooModuleSpecifier(node.arguments[0])
    ) {
      hasDynamicImport = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return hasDynamicImport;
}

function fileHasRuntimePromptfooAccess(path: string): boolean {
  return hasRuntimePromptfooAccess(readFileSync(path, "utf8"), path);
}

describe("promptfoo evaluate import boundary", () => {
  it.each([
    ["named value import", 'import { ApiProvider } from "promptfoo";'],
    ["namespace import", 'import * as promptfoo from "promptfoo"; promptfoo.evaluate({});'],
    ["default import", 'import promptfoo from "promptfoo"; promptfoo.evaluate({});'],
    ["side-effect import", 'import "promptfoo";'],
    ["dynamic import", 'const promptfoo = await import("promptfoo");'],
    ["named re-export", 'export { evaluate } from "promptfoo";'],
    ["star re-export", 'export * from "promptfoo";'],
    ["namespace re-export", 'export * as promptfoo from "promptfoo";'],
  ])("rejects %s runtime access", (_label, sourceText) => {
    expect(hasRuntimePromptfooAccess(sourceText)).toBe(true);
  });

  it.each([
    ["declaration-level type import", 'import type { EvaluateOptions } from "promptfoo";'],
    ["specifier-level type import", 'import { type EvaluateOptions } from "promptfoo";'],
    ["declaration-level type re-export", 'export type { EvaluateOptions } from "promptfoo";'],
    ["specifier-level type re-export", 'export { type EvaluateOptions } from "promptfoo";'],
    ["import type expression", 'type Promptfoo = typeof import("promptfoo");'],
  ])("allows %s", (_label, sourceText) => {
    expect(hasRuntimePromptfooAccess(sourceText)).toBe(false);
  });

  it("allows runtime Promptfoo access only in the shared runner", () => {
    const offendingFiles = globSync("src/**/*.ts")
      .map((path) => relative(process.cwd(), path))
      .filter((path) => path !== sharedPromptfooRunner && fileHasRuntimePromptfooAccess(path))
      .sort();

    expect(offendingFiles).toEqual([]);
  });
});
