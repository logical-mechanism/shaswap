import { NextResponse } from "next/server";

/**
 * Run a route handler's provider work and map any thrown error to a controlled
 * 502 — without leaking internals to the client (the real error is logged
 * server-side only). With the MockProvider this never throws, but the data seam
 * is built to swap in a real provider (Blockfrost / our own Dolos node), which
 * can fail on network/parse; this is the single place that failure is contained.
 */
export async function providerJson<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    console.error(`[api] ${label} provider error:`, e);
    return NextResponse.json({ error: "provider unavailable" }, { status: 502 });
  }
}
