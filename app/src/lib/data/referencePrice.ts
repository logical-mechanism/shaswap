/**
 * External market-price reference (app-only; server-side).
 *
 * A pool's FIRST deposit sets its opening price, and a creator guessing both sides blind can
 * open it badly. This module fetches a NON-BINDING reference price from a free public DEX
 * source (MuesliSwap) so the UI can suggest a sane second amount. It is a pure convenience:
 *
 *  - The CORE never depends on it (no oracle in the protocol — BLUEPRINT §3). It only feeds a
 *    UI hint; the user still sets the real opening price, and the app works fine without it.
 *  - It is FREE and key-less (MuesliSwap fair-use), so it doesn't add a paid dependency, and
 *    it stays server-side behind the data seam (the client only ever hits `/api/*`).
 *  - It fails safe: any error / unknown token / non-mainnet network → null (no suggestion).
 *
 * Confined to ONE file so the source is easy to verify or swap. To change DEX, reimplement
 * `adaPerToken` against another free endpoint — nothing else moves.
 *
 * MuesliSwap `GET /price?base-policy-id=&base-tokenname=&quote-policy-id=<p>&quote-tokenname=<n>`
 * (empty base = ADA) returns `{ price, baseDecimalPlaces, quoteDecimalPlaces, ... }` where
 * `price` is RAW base-base-units per quote-base-unit (verified: HOSKY, 0 decimals, returns
 * ~0.045 = lovelace-per-HOSKY ⇒ ~4.5e-8 ADA), so it must be decimal-adjusted.
 */

import { APP_CONFIG } from "../config";
import { log } from "../log";
import type { ReferencePrice } from "./types";
import { composePricePerA, humanAdaPerToken } from "./referencePriceMath";

const SOURCE = "MuesliSwap";
const PRICE_URL = "https://api.muesliswap.com/price";
const TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 30_000;

type Cached = { at: number; value: number | null };
const adaPriceCache = new Map<string, Cached>();

/** Human ADA price of a token unit (1 for ADA), or null when the source has no usable price. */
async function adaPerToken(unit: string): Promise<number | null> {
  if (unit === "lovelace") return 1;
  const cached = adaPriceCache.get(unit);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const policy = unit.slice(0, 56);
  const name = unit.slice(56);
  const url = `${PRICE_URL}?base-policy-id=&base-tokenname=&quote-policy-id=${policy}&quote-tokenname=${name}`;

  let value: number | null = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = (await res.json()) as {
        price?: unknown;
        baseDecimalPlaces?: unknown;
        quoteDecimalPlaces?: unknown;
      };
      const price = typeof j.price === "number" ? j.price : NaN;
      const baseDec = typeof j.baseDecimalPlaces === "number" ? j.baseDecimalPlaces : 6;
      const quoteDec = typeof j.quoteDecimalPlaces === "number" ? j.quoteDecimalPlaces : 0;
      if (Number.isFinite(price) && price > 0) {
        const human = humanAdaPerToken(price, baseDec, quoteDec);
        if (Number.isFinite(human) && human > 0) value = human;
      }
    }
  } catch (e) {
    log.warn("reference price fetch failed", { unit, err: String(e) });
  }
  // Cache the outcome (including null) briefly so a quiet/unknown token isn't re-hit per keystroke.
  adaPriceCache.set(unit, { at: Date.now(), value });
  return value;
}

/**
 * A non-binding market reference: human tokenB per 1 human tokenA, via the free MuesliSwap
 * price API. Null on any failure / unsupported token / non-mainnet network. App-only.
 */
export async function getReferencePrice(
  tokenAUnit: string,
  tokenBUnit: string,
): Promise<ReferencePrice | null> {
  // MuesliSwap only has mainnet markets; testnets have no reference (test tokens aren't listed).
  if (APP_CONFIG.network !== "mainnet") return null;
  if (!tokenAUnit || !tokenBUnit || tokenAUnit === tokenBUnit) return null;

  const [adaA, adaB] = await Promise.all([
    adaPerToken(tokenAUnit),
    adaPerToken(tokenBUnit),
  ]);
  if (adaA === null || adaB === null) return null;

  const pricePerA = composePricePerA(adaA, adaB);
  if (pricePerA === null) return null;
  return { pricePerA, source: SOURCE };
}
