"use client";

/**
 * Map the raw errors thrown by wallets (CIP-30), MeshJS, and the node/provider into
 * short, human-readable messages for the UI. Wallet/ledger errors are notoriously
 * cryptic ("BadInputsUTxO", a bare `{ code: 2 }`); surfacing them verbatim is hostile.
 *
 * Always falls back to a trimmed version of the original so nothing is fully hidden.
 */

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

/** CIP-30 sign/submit error codes: 1 = Proof/Refused, 2 = UserDeclined. */
function isUserDeclined(e: unknown, text: string): boolean {
  const code = (e as { code?: unknown })?.code;
  if (code === 2 || code === 1) return true;
  return /declin|reject|cancel|denied|user\s*refus/i.test(text);
}

const RULES: { match: RegExp; message: string }[] = [
  {
    match: /badinputsutxo|input.*(not\s*found|does\s*not\s*exist|already|spent)|valuenotconserved/i,
    message:
      "An input was already spent — the order may have just settled or been reclaimed. Refresh and try again.",
  },
  {
    match: /insufficient|not\s*enough|balance.*insufficient|min(imum)?\s*ada|outputtoosmall/i,
    message: "Not enough funds in the wallet to cover the order and fees.",
  },
  {
    match: /collateral/i,
    message:
      "Your wallet has no collateral set. Add a collateral UTXO in the wallet and retry.",
  },
  {
    match: /network|wrong\s*network|magic/i,
    message: "Your wallet is on a different network than the app (preprod).",
  },
  {
    match: /script.*(fail|error)|evaluat|phase-?2|ex\s*units|redeemer/i,
    message:
      "The transaction failed validation. The order may have changed on-chain — refresh and try again.",
  },
];

/** Turn an unknown thrown value into a short, user-facing message. */
export function toUserMessage(e: unknown): string {
  const text = rawText(e).trim();
  if (isUserDeclined(e, text)) return "Request rejected in the wallet.";
  for (const { match, message } of RULES) {
    if (match.test(text)) return message;
  }
  if (!text) return "Something went wrong. Please try again.";
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
