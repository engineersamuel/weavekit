import { configDefaults, defineConfig } from "vitest/config";

const runLegacyWorkflowTests = process.env.WEAVEKIT_RUN_LEGACY_WORKFLOW_TESTS === "1";

const legacyWorkflowTestExcludes = [
  "tests/cli.test.ts",
  "tests/decision-council/**",
  "tests/eval/council-provider.test.ts",
  "tests/eval/sourceToProjectVerification/**",
  "tests/flue/decisionCouncil*.test.ts",
  "tests/macro-workflow/sourceToProject/**",
  "tests/macro-workflow/templateOptimizer/**",
  "tests/mise-source-to-project.test.ts",
  "tests/optimize-template.test.ts",
  "tests/scripts/source-to-project-*.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: runLegacyWorkflowTests
      ? configDefaults.exclude
      : [...configDefaults.exclude, ...legacyWorkflowTestExcludes],
  },
  assetsInclude: ["**/*.md"],
});
