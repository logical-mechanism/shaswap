import { NextResponse } from "next/server";
import { errText, log } from "./log";

/**
 * Run a route handler's provider work and map any thrown error to a controlled
 * 502 — without leaking internals to the client (the real error is logged
 * server-side only). With the MockProvider this never throws, but the data seam
 * is built to swap in a real provider (Blockfrost / our own Dolos node), which
 * can fail on network/parse; this is the single place that failure is contained.
 *
 * Also the single place server reads are timed: a slow read is logged as a warning so
 * a degraded provider is visible in the deploy logs (DigitalOcean captures stdout).
 */
const SLOW_MS = 2000;

export async function providerJson<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<NextResponse> {
  const started = Date.now();
  try {
    const data = await fn();
    const ms = Date.now() - started;
    if (ms > SLOW_MS) log.warn("slow provider read", { label, ms });
    return NextResponse.json(data);
  } catch (e) {
    log.error("provider error", { label, ms: Date.now() - started, err: errText(e) });
    return NextResponse.json({ error: "provider unavailable" }, { status: 502 });
  }
}
