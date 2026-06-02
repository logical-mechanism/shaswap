"use client";

/**
 * Client-side transaction building for the non-custodial paths (post order, reclaim).
 *
 * The tx is BUILT and SIGNED in the browser with the connected wallet (CIP-30) — the
 * app never holds keys. Any chain data the build needs (protocol params, script
 * ex-units) is fetched from our OWN `/api/*` (the data seam), never a provider SDK in
 * the browser. Submission goes through the wallet.
 */

import { deserializeAddress, MeshTxBuilder } from "@meshsdk/core";
import type { Action, IEvaluator, IWallet, Protocol, UTxO } from "@meshsdk/core";
import type { Pool } from "@/lib/data";
import { buildOrder } from "@/lib/chain/order";
import { orderReclaimRedeemer } from "@/lib/chain/datums";
import {
  ORDER_REF,
  ORDER_SCRIPT_HASH,
  ORDER_SCRIPT_SIZE,
} from "@/lib/chain/deployment";

/** Protocol params via the seam (server fetches them from the provider). */
async function fetchProtocolParams(): Promise<Protocol> {
  const res = await fetch("/api/protocol-params");
  if (!res.ok) throw new Error(`protocol-params request failed (${res.status})`);
  const { params } = (await res.json()) as { params: Protocol };
  return params;
}

/** Resolve a single on-chain UTXO (value + inline datum) via the seam. */
async function fetchUtxo(txHash: string, index: number): Promise<UTxO> {
  const res = await fetch(`/api/tx/utxo?tx=${txHash}&index=${index}`);
  if (!res.ok) throw new Error(`utxo resolve request failed (${res.status})`);
  const { utxo } = (await res.json()) as { utxo: UTxO | null };
  if (!utxo) throw new Error("order UTXO not found — already spent or settled");
  return utxo;
}

/** Script ex-units via the seam (Blockfrost evaluateTransaction, server-side). */
const evaluator: IEvaluator = {
  async evaluateTx(tx: string): Promise<Omit<Action, "data">[]> {
    const res = await fetch("/api/tx/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx }),
    });
    if (!res.ok) throw new Error(`evaluate request failed (${res.status})`);
    const { actions } = (await res.json()) as {
      actions: Omit<Action, "data">[];
    };
    return actions;
  },
};

export interface PostOrderArgs {
  /** The pool the order trades against (gives the pair + NFT identity binding). */
  pool: Pool;
  /** Unit being sold (must be one side of the pool pair). */
  sellUnit: string;
  /** Amount of `sellUnit` to sell, base units. */
  sellAmount: bigint;
  /** Per-order floor — minimum amount of the bought asset (base units). */
  limit: bigint;
  /** Solver tip in lovelace. */
  tip: bigint;
  partial: boolean;
  deadline: bigint | null;
}

/**
 * Build → sign → submit an order: a plain payment to the `S`-tagged order address
 * with the inline `OrderDatum`, funded by the wallet's own UTXOs. No script runs at
 * creation. Returns the submitted tx hash.
 *
 * The order is validated + encoded by `buildOrder` (it throws on anything malformed,
 * so a bad order never reaches the chain). The owner is the wallet's own payment key
 * hash — making the order owner-reclaimable (the non-custodial guarantee).
 */
export async function postOrder(
  wallet: IWallet,
  args: PostOrderArgs,
): Promise<string> {
  const changeAddress = await wallet.getChangeAddress();
  const ownerPkh = deserializeAddress(changeAddress).pubKeyHash;

  const built = buildOrder({
    ownerPkh,
    poolNftUnit: args.pool.id,
    assetAUnit: args.pool.tokenA.unit,
    assetBUnit: args.pool.tokenB.unit,
    sellUnit: args.sellUnit,
    sellAmount: args.sellAmount,
    limit: args.limit,
    tip: args.tip,
    partial: args.partial,
    deadline: args.deadline,
  });

  const [params, utxos] = await Promise.all([
    fetchProtocolParams(),
    wallet.getUtxos(),
  ]);

  const txBuilder = new MeshTxBuilder({ params });
  const unsignedTx = await txBuilder
    .txOut(built.address, built.value)
    .txOutInlineDatumValue(built.datum) // default "Mesh" datum type
    .changeAddress(changeAddress)
    .selectUtxosFrom(utxos)
    .complete();

  const signedTx = await wallet.signTx(unsignedTx);
  return wallet.submitTx(signedTx);
}

/**
 * Build → sign → submit an owner-reclaim of one's own order (the `Reclaim` path).
 *
 * Spends the order UTXO with the `Reclaim` redeemer via the on-chain order reference
 * script (no inlined validator). The order validator requires the owner's signature,
 * so `requiredSignerHash(ownerPkh)` + the wallet signing IS the authorization — every
 * well-formed order is reclaimable by its owner, the non-custodial guarantee. The
 * full order value (min-ADA + tip + any sold asset) returns to the owner as change.
 *
 * `ref` is the order's output reference as `"<txHash>#<index>"`.
 */
export async function reclaimOrder(
  wallet: IWallet,
  ref: string,
): Promise<string> {
  const [txHash, indexStr] = ref.split("#");
  const index = Number(indexStr);
  if (!txHash || !Number.isInteger(index)) {
    throw new Error(`malformed order ref: ${ref}`);
  }

  const [order, params, changeAddress, collateral, utxos] = await Promise.all([
    fetchUtxo(txHash, index),
    fetchProtocolParams(),
    wallet.getChangeAddress(),
    wallet.getCollateral(),
    wallet.getUtxos(),
  ]);
  const ownerPkh = deserializeAddress(changeAddress).pubKeyHash;
  const col = collateral[0];
  if (!col) {
    throw new Error("no collateral in wallet — set a collateral UTXO and retry");
  }

  // The collateral input must be DISJOINT from regular spend inputs (the ledger
  // rejects a tx that uses one UTXO as both), so exclude every collateral UTXO from
  // the funding-selection set — otherwise coin selection can pick it to cover the fee.
  const collateralRefs = new Set(
    collateral.map((c) => `${c.input.txHash}#${c.input.outputIndex}`),
  );
  const fundingUtxos = utxos.filter(
    (u) => !collateralRefs.has(`${u.input.txHash}#${u.input.outputIndex}`),
  );

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  const unsignedTx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      order.input.txHash,
      order.input.outputIndex,
      order.output.amount,
      order.output.address,
    )
    .spendingTxInReference(
      ORDER_REF.txHash,
      ORDER_REF.outputIndex,
      ORDER_SCRIPT_SIZE.toString(),
      ORDER_SCRIPT_HASH,
    )
    .spendingReferenceTxInInlineDatumPresent()
    .spendingReferenceTxInRedeemerValue(orderReclaimRedeemer)
    .txInCollateral(
      col.input.txHash,
      col.input.outputIndex,
      col.output.amount,
      col.output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(changeAddress)
    .selectUtxosFrom(fundingUtxos)
    .complete();

  const signedTx = await wallet.signTx(unsignedTx);
  return wallet.submitTx(signedTx);
}
