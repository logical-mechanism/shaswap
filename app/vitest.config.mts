import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Component / hook test runner — SEPARATE from `npm test` (the Node built-in runner that
 * pins the pure encoding/order/funding logic). This one renders React in jsdom with
 * @testing-library, so it needs a real bundler (esbuild via Vite) + the `@/` path alias.
 *
 * The two suites never overlap: this picks up `*.vitest.{ts,tsx}` ONLY, and the Node
 * runner globs `*.test.ts` ONLY — so neither runner ever loads the other's files.
 *
 * This file is excluded from the `tsc` gate (see tsconfig) — `vitest/config` re-exports a
 * nested Vite whose Plugin type clashes with `@vitejs/plugin-react`'s top-level one under
 * tsc. It's validated by actually running (`npm run test:components`).
 *
 * The `@/` alias is wired explicitly (not via tsconfig) because the test + fixture files
 * are excluded from tsconfig — vite-tsconfig-paths would then skip resolving their imports.
 * `@/x` maps to `src/x`; `@rollup/plugin-alias` only matches `@` followed by `/`, so bare
 * scoped packages like `@meshsdk/core` are untouched.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.vitest.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
