import importPlugin from "eslint-plugin-import";

export default [
  { ignores: ["dist/**", "coverage/**"] },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    plugins: { import: importPlugin },
    languageOptions: { globals: { process: "readonly" } },
    rules: {
      eqeqeq: "error",
      "no-warning-comments": ["warn", { terms: ["TODO"] }],
      "import/no-unresolved": "error",
    },
  },
];
