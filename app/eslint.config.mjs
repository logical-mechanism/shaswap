import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Unit tests run on Node's runner with TS type-stripping (see package.json
    // `test`); they use `.ts` import specifiers the bundler/lint config rejects.
    "**/*.test.ts",
    // Component/hook tests (Vitest + jsdom) and the Playwright E2E suite run on their
    // OWN runners (see `test:components` / `e2e`); like the Node tests above they're
    // kept out of the app's lint/type gates and enforced by their runners instead.
    "**/*.vitest.ts",
    "**/*.vitest.tsx",
    "src/test/**",
    "e2e/**",
    "playwright.config.ts",
  ]),
]);

export default eslintConfig;
