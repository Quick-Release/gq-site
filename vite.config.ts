import { defineConfig } from "vite-plus";

// Upstream skills and extracted templates/fixtures must stay byte-for-byte intact.
const ignorePatterns = [
  ".agents/**",
  "blueprint/templates/**",
  "test/fixtures/content-site/**",
  "node_modules/**",
  "coverage/**",
];

export default defineConfig({
  fmt: {
    ignorePatterns: [...ignorePatterns, "schema/**"],
    printWidth: 100,
    // Preserve the existing style without introducing import/package reordering.
    sortImports: false,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns,
    plugins: ["eslint"],
    env: { node: true, browser: false },
    categories: { correctness: "error" },
    // ESLint recommended rules outside Oxlint's correctness category.
    // Duplicate parameters and legacy octal literals are already parser errors in ESM.
    rules: {
      "no-case-declarations": "error",
      "no-empty": "error",
      "no-fallthrough": "error",
      "no-prototype-builtins": "error",
      "no-redeclare": "error",
      "no-regex-spaces": "error",
      "no-undef": "error",
      "no-unexpected-multiline": "error",
      // Object options retain ESLint's behavior instead of ignoring `_` names.
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "all" }],
      "no-useless-assignment": "error",
      "preserve-caught-error": "error",
    },
    options: { denyWarnings: true },
  },
});
