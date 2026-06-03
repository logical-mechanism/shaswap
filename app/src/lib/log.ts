/**
 * Tiny zero-dependency structured logger.
 *
 * In production it emits one JSON object per line to stdout/stderr — which is exactly
 * what DigitalOcean's App Platform (and most log shippers) ingest, so there's no mortal
 * external dependency to run the app. In development it prints a compact, readable line.
 *
 * Level is set by `LOG_LEVEL` (debug|info|warn|error; default info). Use it for
 * server-side observability (route handlers, the data provider) — the browser keeps
 * using the inline UI error banners; this is for operators, not users.
 *
 *   log.info("order posted", { txHash });
 *   log.error("quote failed", { err: errText(e) });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  return RANK[env] ?? RANK.info;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < threshold()) return;
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  if (process.env.NODE_ENV === "production") {
    // Spread caller fields FIRST so the canonical level/msg/ts can't be clobbered by a
    // field that happens to be named "level"/"msg"/"ts".
    sink(JSON.stringify({ ...fields, level, msg, ts: new Date().toISOString() }));
  } else {
    sink(`[${level}] ${msg}`, fields && Object.keys(fields).length ? fields : "");
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/**
 * Best-effort short string for an unknown thrown value, safe to log. Mirrors the spirit
 * of the user-facing mapper but keeps the raw text (operators want detail, not friendly
 * copy) — truncated so a giant provider payload can't flood the logs.
 */
export function errText(e: unknown, max = 300): string {
  let s: string;
  if (e instanceof Error) s = e.message;
  else if (typeof e === "string") s = e;
  else {
    try {
      s = JSON.stringify(e);
    } catch {
      s = String(e);
    }
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
