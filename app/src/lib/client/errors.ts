"use client";

/**
 * Map the raw errors thrown by wallets (CIP-30), MeshJS, and the node/provider into
 * short, human-readable messages for the UI. Wallet/ledger errors are notoriously
 * cryptic ("BadInputsUTxO", a bare `{ code: 2 }`); surfacing them verbatim is hostile.
 *
 * Always falls back to a trimmed version of the original so nothing is fully hidden.
 */

import { networkLabel } from "../config.ts";

/** Pull whatever string-ish content an unknown error carries. */
function rawText(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    const o = e as { info?: unknown; message?: unknown; code?: unknown };
    const parts = [o.info, o.message, o.code].filter(
      (x) => typeof x === "string" || typeof x === "number",
    );
    if (parts.length) return parts.map(String).join(" ");
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/**
 * CIP-30 codes differ per call: TxSignError 2 = UserDeclined, but TxSendError 2 =
 * Failure and code 1 = ProofGeneration/Refused (NOT a cancellation). So only trust the
 * text for a decline; treat a bare code as a weak signal (code 2 only).
 */
function isUserDeclined(e: unknown, text: string): boolean {
  if (/declin|reject|cancel|denied|user\s*refus/i.test(text)) return true;
  const code = (e as { code?: unknown })?.code;
  return code === 2 && !text; // code 2 with no other context → likely a sign decline
}

const RULES: { match: RegExp; message: string }[] = [
  {
    match: /badinputsutxo|input.*(not\s*found|does\s*not\s*exist|already|spent)|valuenotconserved/i,
    message:
      "An input was already spent. The order may have just settled or been reclaimed. Refresh and try again.",
  },
  {
    match: /insufficient|not\s*enough|balance.*insufficient|min(imum)?\s*ada|outputtoosmall/i,
    message: "Not enough funds in the wallet to cover the order and fees.",
  },
  {
    match: /collateral/i,
    message:
      "Your wallet has no collateral set — a small ADA buffer it holds aside for smart-contract actions. Add one in your wallet, then retry.",
  },
  {
    match: /wrong\s*network|network\s*(mismatch|id)|network\s*magic|networkmagic|different\s*network/i,
    message: `Your wallet is on a different network than the app (${networkLabel()}).`,
  },
  {
    // Cost-model / script-integrity-hash mismatch: the protocol params the tx was built
    // with don't match the node's. Usually transient (params changed) — a refresh + rebuild
    // picks up the current ones. Keep ABOVE the generic script-failure rule.
    match: /script\s*integrity|integrity\s*hash|cost\s*model|costmdls|plutus.*cost/i,
    message:
      "The network parameters changed while building this transaction. Refresh and try again.",
  },
  {
    match: /script.*(fail|error)|evaluat|phase-?2|ex\s*units|redeemer/i,
    message:
      "The transaction failed validation. The order may have changed on-chain. Refresh and try again.",
  },
  {
    // Provider/indexer unavailable or lagging (Blockfrost 5xx/429, timeouts, fetch fails).
    // Distinct from a tx error — the chain is fine, the read path is momentarily down.
    match: /\b(429|50[234])\b|too\s*many\s*requests|rate\s*limit|service\s*unavailable|bad\s*gateway|gateway\s*time|timed?\s*out|timeout|network\s*request\s*failed|fetch\s*failed|econnrefused|enotfound/i,
    message:
      "Pip can’t reach the data service right now. Give it a moment and refresh.",
  },
];

/**
 * Whether an unmapped error's raw text is machine gibberish (a JSON/object dump, a hex blob,
 * a bare numeric code, or a spaceless CamelCase ledger identifier like `BadInputsUTxO`) rather
 * than a readable sentence. We hide gibberish behind a calm line so the brand never leaks a
 * cryptic string the moment an unmapped error fires — but still let a genuine human message
 * through (truncated), since those are often the most useful thing to show. Kept deliberately
 * NARROW so a readable sentence that merely embeds a brace ("Build failed: { code 5 }") or is
 * written in a non-Latin script still reaches the user — only pure machine output is hidden.
 */
function looksMachine(text: string): boolean {
  if (/^[{[]/.test(text)) return true; // STARTS as a JSON/object/array dump
  if (/0x[0-9a-f]{6,}/i.test(text)) return true; // hex blob
  if (!/\p{L}/u.test(text)) return true; // no letters in ANY script → a bare code/number
  if (!/\s/.test(text) && /[a-z][A-Z]/.test(text)) return true; // spaceless CamelCase id
  return false;
}

/** Turn an unknown thrown value into a short, user-facing message. */
export function toUserMessage(e: unknown): string {
  const text = rawText(e).trim();
  if (isUserDeclined(e, text)) return "Request rejected in the wallet.";
  for (const { match, message } of RULES) {
    if (match.test(text)) return message;
  }
  if (!text) return "Pip’s not sure what happened there. Give it another go.";
  if (looksMachine(text)) {
    // Keep the cryptic detail out of the UI, but don't lose it for debugging.
    if (typeof console !== "undefined") console.warn("[shaswap] unmapped error:", e);
    return "Pip hit a snag finishing that. Refresh and try again.";
  }
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
