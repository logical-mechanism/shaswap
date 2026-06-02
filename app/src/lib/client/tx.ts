"use client";

/**
 * Client-side transaction building for the non-custodial paths (post order, reclaim,
 * LP deposit/withdraw).
 *
 * The tx is BUILT and SIGNED in the browser with the connected wallet (CIP-30) — the
 * app never holds keys. Any chain data the build needs (protocol params, script
 * ex-units, the pool/order UTXO) is fetched from our OWN `/api/*` (the data seam),
 * never a provider SDK in the browser. Submission goes through the wallet.
 */

import { deserializeAddress, MeshTxBuilder } from "@meshsdk/core";
import type { Action, IEvaluator, IWallet, Protocol, UTxO } from "@meshsdk/core";
import type { Pool } from "@/lib/data";
import { buildOrder } from "@/lib/chain/order";
import { decodePoolDatum, lpActionRedeemer, orderReclaimRedeemer } from "@/lib/chain/datums";
import { deriveEnterpriseScriptAddress } from "@/lib/chain/address";
import {
  buildDeposit,
  buildWithdraw,
  type PoolView,
} from "@/lib/chain/lp";
import {
  DEPLOYMENT_NETWORK_ID,
  lpUnitForPool,
  ORDER_REF,
  ORDER_SCRIPT_HASH,
  ORDER_SCRIPT_SIZE,
  POOL_ADDR,
  POOL_MIN_ADA,
  POOL_REF,
  POOL_SCRIPT_HASH,
  POOL_SCRIPT_SIZE,
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

/** Resolve the live pool UTXO (value + inline `PoolDatum`) by NFT unit, via the seam. */
async function fetchPoolUtxo(nftUnit: string): Promise<UTxO> {
  const res = await fetch(`/api/tx/pool-utxo?nft=${nftUnit}`);
  if (!res.ok) throw new Error(`pool utxo resolve request failed (${res.status})`);
  const { utxo } = (await res.json()) as { utxo: UTxO | null };
  if (!utxo) throw new Error("pool UTXO not found — it may have just moved; refresh and retry");
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
 *
 * Returns the tx hash, the order's output reference (`<hash>#0` — the order is the
 * first output; change is appended last), and the owner (change) address, so the UI
 * can record a pending-activity entry and match it against the on-chain order list.
 */
export interface PostOrderResult {
  txHash: string;
  orderRef: string;
  owner: string;
}

export async function postOrder(
  wallet: IWallet,
  args: PostOrderArgs,
): Promise<PostOrderResult> {
  const changeAddress = await wallet.getChangeAddress();
  const { pubKeyHash, stakeCredentialHash, stakeScriptCredentialHash } =
    deserializeAddress(changeAddress);

  // Carry the wallet's own stake credential so the settled payout lands at a BASE
  // address the wallet displays + can spend (Lace tracks only base variants of its
  // keys). MeshJS returns "" for an absent part; key stake cred wins, then script,
  // else enterprise (null). The contract pins this from the datum (solver can't
  // redirect it), and spending stays controlled by the payment key (`ownerPkh`).
  const ownerStake = stakeCredentialHash
    ? ({ kind: "key", hash: stakeCredentialHash } as const)
    : stakeScriptCredentialHash
      ? ({ kind: "script", hash: stakeScriptCredentialHash } as const)
      : null;

  const built = buildOrder({
    ownerPkh: pubKeyHash,
    ownerStake,
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
  const txHash = await wallet.submitTx(signedTx);
  return { txHash, orderRef: `${txHash}#0`, owner: changeAddress };
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

/**
 * Shared wallet inputs for a Plutus spend: protocol params, change address, a
 * collateral UTXO, and the funding set with every collateral UTXO excluded (the ledger
 * rejects a UTXO used as both collateral and a regular input). Mirrors the collateral
 * handling in `reclaimOrder`.
 */
async function spendContext(wallet: IWallet) {
  const [params, changeAddress, collateral, utxos] = await Promise.all([
    fetchProtocolParams(),
    wallet.getChangeAddress(),
    wallet.getCollateral(),
    wallet.getUtxos(),
  ]);
  const col = collateral[0];
  if (!col) {
    throw new Error("no collateral in wallet — set a collateral UTXO and retry");
  }
  const collateralRefs = new Set(
    collateral.map((c) => `${c.input.txHash}#${c.input.outputIndex}`),
  );
  const fundingUtxos = utxos.filter(
    (u) => !collateralRefs.has(`${u.input.txHash}#${u.input.outputIndex}`),
  );
  return { params, changeAddress, col, fundingUtxos };
}

export interface DepositLiquidityArgs {
  /** The pool to add liquidity to. */
  pool: Pool;
  /** Amount of `asset_a` to add (base units). */
  deltaA: bigint;
  /** Amount of `asset_b` to add (base units). */
  deltaB: bigint;
  /** Optional minimum LP to receive — a client-side slippage guard (throws if below). */
  minLpOut?: bigint;
}

export interface LiquidityResult {
  txHash: string;
}

/**
 * Build → sign → submit an LP **deposit** (BLUEPRINT §6). A standalone tx like
 * reclaim — no solver, no settlement anchor. Spends the pool UTXO with the `LpAction`
 * redeemer via the pool reference script, recreates the pool (same address, same datum
 * — CBOR passthrough so `out.datum == in.datum` — reserves +Δ, held LP lowered by the
 * minted shares, 1 NFT, no reference script), and funds Δ from the wallet. The minted
 * LP (and any change) returns to the wallet. On the FIRST deposit it also locks
 * `min_liq` LP at the unspendable `Script(nft.policy)` address.
 *
 * The share math + value layout live in the pure `buildDeposit` (it throws on a
 * malformed intent, so a bad deposit never reaches the chain). No owner signature is
 * required — `lp_action` checks per-share backing, not a signature; the wallet still
 * signs to spend its funding inputs.
 */
export async function depositLiquidity(
  wallet: IWallet,
  args: DepositLiquidityArgs,
): Promise<LiquidityResult> {
  const poolUtxo = await fetchPoolUtxo(args.pool.id);
  const datumCbor = poolUtxo.output.plutusData;
  if (!datumCbor) throw new Error("pool UTXO has no inline datum");
  const datum = decodePoolDatum(datumCbor);
  const view: PoolView = { value: poolUtxo.output.amount, datum };
  const built = buildDeposit({
    view,
    deltaA: args.deltaA,
    deltaB: args.deltaB,
    minLpOut: args.minLpOut,
  });

  const { params, changeAddress, col, fundingUtxos } = await spendContext(wallet);

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      poolUtxo.input.txHash,
      poolUtxo.input.outputIndex,
      poolUtxo.output.amount,
      poolUtxo.output.address,
    )
    .spendingTxInReference(
      POOL_REF.txHash,
      POOL_REF.outputIndex,
      POOL_SCRIPT_SIZE.toString(),
      POOL_SCRIPT_HASH,
    )
    .spendingReferenceTxInInlineDatumPresent()
    .spendingReferenceTxInRedeemerValue(lpActionRedeemer)
    .txInCollateral(
      col.input.txHash,
      col.input.outputIndex,
      col.output.amount,
      col.output.address,
    )
    .txOut(POOL_ADDR, built.poolValue)
    .txOutInlineDatumValue(datumCbor, "CBOR");

  // First deposit: permanently lock `min_liq` LP at `Script(nft.policy)` (the pool's
  // own unspendable mint policy). The depositor's LP (circ_out − min_liq) is change.
  if (built.firstDeposit && built.lockLp !== null) {
    const lockAddr = deriveEnterpriseScriptAddress(
      datum.nft.policy,
      DEPLOYMENT_NETWORK_ID,
    );
    txBuilder.txOut(lockAddr, [
      { unit: "lovelace", quantity: POOL_MIN_ADA.toString() },
      { unit: lpUnitForPool(args.pool.id), quantity: built.lockLp.toString() },
    ]);
  }

  const unsignedTx = await txBuilder
    .changeAddress(changeAddress)
    .selectUtxosFrom(fundingUtxos)
    .complete();

  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);
  return { txHash };
}

export interface WithdrawLiquidityArgs {
  /** The pool to remove liquidity from. */
  pool: Pool;
  /** Circulating LP to burn (base units). */
  lpToBurn: bigint;
  /** Optional minimum `asset_a` / `asset_b` to receive — client-side slippage guards. */
  minAOut?: bigint;
  minBOut?: bigint;
}

/**
 * Build → sign → submit an LP **withdraw** (BLUEPRINT §6). Spends the pool UTXO with
 * the `LpAction` redeemer via the pool reference script and recreates the pool with
 * reserves −recv and held LP raised by the burned shares. The wallet funds `lpToBurn`
 * LP (coin selection picks the LP-bearing UTXO) and receives a proportional, floored
 * share of both reserves as change. `buildWithdraw` enforces `circ_out ≥ min_liq` and
 * throws on a malformed intent.
 */
export async function withdrawLiquidity(
  wallet: IWallet,
  args: WithdrawLiquidityArgs,
): Promise<LiquidityResult> {
  const poolUtxo = await fetchPoolUtxo(args.pool.id);
  const datumCbor = poolUtxo.output.plutusData;
  if (!datumCbor) throw new Error("pool UTXO has no inline datum");
  const datum = decodePoolDatum(datumCbor);
  const view: PoolView = { value: poolUtxo.output.amount, datum };
  const built = buildWithdraw({
    view,
    lpToBurn: args.lpToBurn,
    minAOut: args.minAOut,
    minBOut: args.minBOut,
  });

  const { params, changeAddress, col, fundingUtxos } = await spendContext(wallet);

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  const unsignedTx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      poolUtxo.input.txHash,
      poolUtxo.input.outputIndex,
      poolUtxo.output.amount,
      poolUtxo.output.address,
    )
    .spendingTxInReference(
      POOL_REF.txHash,
      POOL_REF.outputIndex,
      POOL_SCRIPT_SIZE.toString(),
      POOL_SCRIPT_HASH,
    )
    .spendingReferenceTxInInlineDatumPresent()
    .spendingReferenceTxInRedeemerValue(lpActionRedeemer)
    .txInCollateral(
      col.input.txHash,
      col.input.outputIndex,
      col.output.amount,
      col.output.address,
    )
    .txOut(POOL_ADDR, built.poolValue)
    .txOutInlineDatumValue(datumCbor, "CBOR")
    .changeAddress(changeAddress)
    .selectUtxosFrom(fundingUtxos)
    .complete();

  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);
  return { txHash };
}
