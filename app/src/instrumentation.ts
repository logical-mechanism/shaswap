/**
 * Next.js instrumentation — runs once at server startup. We use it to VALIDATE the
 * data-provider configuration eagerly (`getDataProvider()` throws on a mock-in-prod
 * misconfig), so a bad deploy fails fast at boot instead of only surfacing on the first
 * `/api/*` request. It also emits the one-time "data provider selected" log.
 *
 * Skipped during `next build`: the provider key is a RUNTIME secret (set on the deploy,
 * not at build time), so validating it there would wrongly force the key into the build.
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { getDataProvider } = await import("@/lib/data");
    getDataProvider();
  }
}
