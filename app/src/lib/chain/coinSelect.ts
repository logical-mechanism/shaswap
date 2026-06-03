import type { UTxO } from "@meshsdk/core";

/** `"txHash#index"` — a UTXO's unique on-chain reference. */
export function utxoRef(u: UTxO): string {
  return `${u.input.txHash}#${u.input.outputIndex}`;
}

/**
 * The wallet's funding set with every collateral UTXO removed. The ledger rejects a tx
 * that uses one UTXO as BOTH collateral and a regular input, so collateral must be
 * excluded from coin selection. Shared by every script spend (reclaim / deposit /
 * withdraw / create / close) — it used to be inlined identically in two places.
 *
 * Pure: `import type` is erased at runtime, so this carries no SDK dependency and is
 * unit-testable on its own.
 */
export function excludeCollateral(utxos: UTxO[], collateral: UTxO[]): UTxO[] {
  const refs = new Set(collateral.map(utxoRef));
  return utxos.filter((u) => !refs.has(utxoRef(u)));
}
