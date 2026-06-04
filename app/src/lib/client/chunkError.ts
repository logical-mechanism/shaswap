/**
 * Recovery for a failed code-split chunk load.
 *
 * A `ChunkLoadError` typically means an old browser tab asked for a hashed JS/CSS chunk
 * that no longer exists after a redeploy (immutable, content-hashed filenames change each
 * build), or a transient network drop while fetching one (the PageSpeed run logged exactly
 * this: `ERR_CONNECTION_FAILED` on a `/_next/static/chunks/*` request). Reloading the page
 * pulls the current chunk manifest and recovers. This became more relevant once tx-building
 * moved behind dynamic `import()` (those load chunks on demand).
 */

/** True when `error` looks like a failed dynamic/async chunk load (webpack or Turbopack). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: string; message?: string };
  if (name === "ChunkLoadError") return true;
  const msg = message ?? "";
  return (
    /Loading chunk [\w-]+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /Failed to (load|fetch) .*chunk/i.test(msg) ||
    /(error|failed) .*dynamically imported module/i.test(msg)
  );
}

const RELOAD_TS_KEY = "shaswap-chunk-reload-ts";
// A reload loop (chunk still missing after the reload) recurs near-instantly, so suppress
// re-reloads within this window. A chunk error that recurs LATER (a fresh deploy mid-session)
// falls outside it and self-heals again — no "clear on success" bookkeeping needed.
const RELOAD_WINDOW_MS = 10_000;

/**
 * On a chunk-load error, reload ONCE to fetch the fresh manifest. Returns true if a reload
 * was triggered (the caller should stop — the document is about to be replaced). Guarded by
 * a sessionStorage timestamp so a genuinely broken chunk can't trap the user in a reload
 * loop; the second occurrence falls through to the normal error UI.
 */
export function reloadOnceOnChunkError(error: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_TS_KEY) ?? "0");
    if (last && Date.now() - last < RELOAD_WINDOW_MS) return false; // just reloaded — don't loop
    sessionStorage.setItem(RELOAD_TS_KEY, String(Date.now()));
  } catch {
    // sessionStorage blocked (private mode / strict settings): reloading without a guard
    // risks a loop, so bail to the normal error UI instead.
    return false;
  }
  window.location.reload();
  return true;
}
