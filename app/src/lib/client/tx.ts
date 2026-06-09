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
import { buildCreatePool } from "@/lib/chain/createPool";
import { buildClosePool, recoverSeed } from "@/lib/chain/closePool";
import {
  closePoolRedeemer,
  decodePoolDatum,
  lpActionRedeemer,
  lpIntentReclaimRedeemer,
  mintCloseRedeemer,
  mintCreateRedeemer,
  orderReclaimRedeemer,
} from "@/lib/chain/datums";
import { deriveEnterpriseScriptAddress } from "@/lib/chain/address";
import { excludeCollateral } from "@/lib/chain/coinSelect";
import {
  buildDeposit,
  buildWithdraw,
  type PoolView,
} from "@/lib/chain/lp";
import {
  buildLpIntentDeposit,
  buildLpIntentWithdraw,
} from "@/lib/chain/lpIntent";
import { lpIntentScriptHash } from "@/lib/chain/lpIntentScript";
import {
  DEPLOYMENT_NETWORK_ID,
  LP_INTENT_SCRIPT_SIZE,
  LP_NAME_HEX,
  lpUnitForPool,
  NFT_NAME_HEX,
  ORDER_SCRIPT_HASH,
  ORDER_SCRIPT_SIZE,
  POOL_ADDR,
  POOL_MIN_ADA,
  POOL_SCRIPT_HASH,
  POOL_SCRIPT_SIZE,
  requireDeployed,
  requireLpIntentDeployed,
  TOTAL_LP,
} from "@/lib/chain/deployment";

/**
 * Protocol params + on-chain cost models via the seam (server fetches them from the
 * provider). The cost models are the per-language parameter arrays `[v1, v2, v3]`; they
 * are needed to compute the script-integrity hash for Plutus spends — MeshJS otherwise
 * falls back to stale baked-in defaults, and preprod is on a newer protocol version
 * (e.g. PlutusV3 = 350 params vs MeshJS's 297), so the node would reject the tx with a
 * "script integrity hash doesn't match" error. ADA-only paths (postOrder) ignore them.
 */
async function fetchProtocolParams(): Promise<{
  params: Protocol;
  costModels: number[][];
}> {
  const res = await fetch("/api/protocol-params");
  if (!res.ok) throw new Error(`protocol-params request failed (${res.status})`);
  const { params, costModels } = (await res.json()) as {
    params: Protocol;
    costModels: number[][];
  };
  return { params, costModels: costModels ?? [] };
}

/** Resolve a single on-chain UTXO (value + inline datum) via the seam. */
async function fetchUtxo(
  txHash: string,
  index: number,
  what = "order",
): Promise<UTxO> {
  const res = await fetch(`/api/tx/utxo?tx=${txHash}&index=${index}`);
  if (!res.ok) throw new Error(`utxo resolve request failed (${res.status})`);
  const { utxo } = (await res.json()) as { utxo: UTxO | null };
  if (!utxo) throw new Error(`${what} UTXO not found — already spent or fulfilled`);
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

/** Resolve the input refs of a pool's mint tx (for one-shot seed recovery), via the seam. */
async function fetchPoolMintInputs(
  nftUnit: string,
): Promise<{ txHash: string; index: number }[]> {
  const res = await fetch(`/api/pool/mint-inputs?nft=${nftUnit}`);
  if (!res.ok) throw new Error(`pool mint-inputs request failed (${res.status})`);
  const { inputs } = (await res.json()) as {
    inputs: { txHash: string; index: number }[];
  };
  return inputs;
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

  // postOrder is a plain payment (no Plutus script), so it needs no cost models.
  const [{ params }, utxos] = await Promise.all([
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
  // Refuse on a network whose reference scripts aren't live yet (also narrows ORDER_REF).
  const { orderRef } = requireDeployed();

  const [order, protocol, changeAddress, collateral, utxos] = await Promise.all([
    fetchUtxo(txHash, index),
    fetchProtocolParams(),
    wallet.getChangeAddress(),
    wallet.getCollateral(),
    wallet.getUtxos(),
  ]);
  const { params, costModels } = protocol;
  const ownerPkh = deserializeAddress(changeAddress).pubKeyHash;
  const col = collateral[0];
  if (!col) {
    throw new Error("no collateral in wallet — set a collateral UTXO and retry");
  }

  // The collateral input must be DISJOINT from regular spend inputs (the ledger rejects
  // a tx that uses one UTXO as both), so exclude every collateral UTXO from the
  // funding-selection set — otherwise coin selection can pick it to cover the fee.
  const fundingUtxos = excludeCollateral(utxos, collateral);

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  // Inject the network's real cost models so the script-integrity hash matches the node.
  txBuilder.setCostModels(costModels);
  const unsignedTx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      order.input.txHash,
      order.input.outputIndex,
      order.output.amount,
      order.output.address,
      0, // scriptSize: the order UTXO carries no attached reference script. Required so MeshTxBuilder.complete() doesn't demand a fetcher (this MeshJS version flags an input with scriptSize===undefined as incomplete).
    )
    .spendingTxInReference(
      orderRef.txHash,
      orderRef.outputIndex,
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
  const [protocol, changeAddress, collateral, utxos] = await Promise.all([
    fetchProtocolParams(),
    wallet.getChangeAddress(),
    wallet.getCollateral(),
    wallet.getUtxos(),
  ]);
  const { params, costModels } = protocol;
  const col = collateral[0];
  if (!col) {
    throw new Error("no collateral in wallet — set a collateral UTXO and retry");
  }
  const fundingUtxos = excludeCollateral(utxos, collateral);
  return { params, costModels, changeAddress, col, fundingUtxos };
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
  const { poolRef } = requireDeployed();
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

  const { params, costModels, changeAddress, col, fundingUtxos } =
    await spendContext(wallet);

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  // Inject the network's real cost models so the script-integrity hash matches the node.
  txBuilder.setCostModels(costModels);
  txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      poolUtxo.input.txHash,
      poolUtxo.input.outputIndex,
      poolUtxo.output.amount,
      poolUtxo.output.address,
      0, // scriptSize: the pool UTXO carries no attached reference script (out.reference_script == None). Required so MeshTxBuilder.complete() doesn't demand a fetcher to resolve it.
    )
    .spendingTxInReference(
      poolRef.txHash,
      poolRef.outputIndex,
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

// ---- batcher-fulfilled LP intents (deposit/withdraw via the permissionless solver) ----

export interface PostLpIntentResult {
  txHash: string;
  /** The intent's output reference (`<hash>#0` — the intent is the first output). */
  ref: string;
  /** The owner (change) address — for matching against the on-chain intent list. */
  owner: string;
}

export interface PostLpIntentDepositArgs {
  /** The pool to add liquidity to (pair + NFT identity binding). */
  pool: Pool;
  /** Amount of `asset_a` to deposit (base units). */
  amountA: bigint;
  /** Amount of `asset_b` to deposit (base units). */
  amountB: bigint;
  /** Owner floor — minimum LP minted, from a conservative quote (`quoteLpDeposit`). */
  minShares: bigint;
  /** Solver tip (lovelace). */
  tip: bigint;
  deadline: bigint | null;
}

export interface PostLpIntentWithdrawArgs {
  pool: Pool;
  /** LP tokens to redeem (base units). */
  lpAmount: bigint;
  /** Owner floors — minimum released `asset_a` / `asset_b` (`quoteLpWithdraw`). */
  minA: bigint;
  minB: bigint;
  tip: bigint;
  deadline: bigint | null;
}

/** The wallet's owner pkh + payout stake credential (shared by both LP-intent posts). */
async function lpIntentOwner(wallet: IWallet) {
  const changeAddress = await wallet.getChangeAddress();
  const { pubKeyHash, stakeCredentialHash, stakeScriptCredentialHash } =
    deserializeAddress(changeAddress);
  // Carry the wallet's own stake credential so the payout lands at a BASE address the wallet
  // displays + can spend (mirrors postOrder / audit M-01; the validator pins it from the datum).
  const ownerStake = stakeCredentialHash
    ? ({ kind: "key", hash: stakeCredentialHash } as const)
    : stakeScriptCredentialHash
      ? ({ kind: "script", hash: stakeScriptCredentialHash } as const)
      : null;
  return { changeAddress, pubKeyHash, ownerStake };
}

/**
 * Build → sign → submit a DEPOSIT intent: a plain payment to the `lp_intent` address with the
 * inline `LpIntentDatum`, funded by the wallet — exactly like `postOrder` (no script runs at
 * creation; the batcher fulfils it later). Gated by `requireLpIntentDeployed()` so a posted
 * intent is never a fund trap (un-fulfillable AND un-reclaimable) before the path is live.
 */
export async function postLpIntentDeposit(
  wallet: IWallet,
  args: PostLpIntentDepositArgs,
): Promise<PostLpIntentResult> {
  requireLpIntentDeployed();
  const { changeAddress, pubKeyHash, ownerStake } = await lpIntentOwner(wallet);

  const built = buildLpIntentDeposit({
    ownerPkh: pubKeyHash,
    ownerStake,
    poolNftUnit: args.pool.id,
    assetAUnit: args.pool.tokenA.unit,
    assetBUnit: args.pool.tokenB.unit,
    amountA: args.amountA,
    amountB: args.amountB,
    minShares: args.minShares,
    tip: args.tip,
    deadline: args.deadline,
  });

  // A plain payment (no Plutus script) — needs no cost models / collateral.
  const [{ params }, utxos] = await Promise.all([
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
  return { txHash, ref: `${txHash}#0`, owner: changeAddress };
}

/**
 * Build → sign → submit a WITHDRAW intent: a plain payment to the `lp_intent` address holding
 * `lpAmount` LP + the inline datum, funded by the wallet (coin selection supplies the LP).
 * Same gate + structure as the deposit post. Reclaim returns the LP tokens, not underlying (§13).
 */
export async function postLpIntentWithdraw(
  wallet: IWallet,
  args: PostLpIntentWithdrawArgs,
): Promise<PostLpIntentResult> {
  requireLpIntentDeployed();
  const { changeAddress, pubKeyHash, ownerStake } = await lpIntentOwner(wallet);

  const built = buildLpIntentWithdraw({
    ownerPkh: pubKeyHash,
    ownerStake,
    poolNftUnit: args.pool.id,
    assetAUnit: args.pool.tokenA.unit,
    assetBUnit: args.pool.tokenB.unit,
    lpAmount: args.lpAmount,
    minA: args.minA,
    minB: args.minB,
    tip: args.tip,
    deadline: args.deadline,
  });

  const [{ params }, utxos] = await Promise.all([
    fetchProtocolParams(),
    wallet.getUtxos(),
  ]);

  // Preflight: the intent UTXO must carry `lpAmount` LP, so the wallet must hold it. Surface a
  // clear error up front rather than an opaque balancer "not enough UTxOs" (mirrors withdrawLiquidity).
  const lpUnit = lpUnitForPool(args.pool.id);
  const walletLp = utxos.reduce((sum, u) => {
    const a = u.output.amount.find((x) => x.unit === lpUnit);
    return sum + (a ? BigInt(a.quantity) : 0n);
  }, 0n);
  if (walletLp < args.lpAmount) {
    throw new Error(
      `wallet holds ${walletLp} LP for this pool — not enough to redeem ${args.lpAmount}`,
    );
  }

  const txBuilder = new MeshTxBuilder({ params });
  const unsignedTx = await txBuilder
    .txOut(built.address, built.value)
    .txOutInlineDatumValue(built.datum)
    .changeAddress(changeAddress)
    .selectUtxosFrom(utxos)
    .complete();

  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);
  return { txHash, ref: `${txHash}#0`, owner: changeAddress };
}

/**
 * Build → sign → submit an owner-reclaim of one's own LP intent (the `ReclaimLp` path).
 *
 * Spends the intent UTXO with the `ReclaimLp` redeemer via the on-chain `lp_intent` reference
 * script (no inlined 2.8 kB validator). The validator requires the owner's signature, so
 * `requiredSignerHash(ownerPkh)` + the wallet signing IS the authorization — every intent is
 * owner-reclaimable. A DEPOSIT reclaim returns `asset_a` + `asset_b`; a WITHDRAW reclaim
 * returns the **LP tokens**, NOT the underlying (the §13 residual — turning LP back into
 * reserves is the pool mutation this path routes around). The full intent value returns to the
 * owner as change. Mirrors `reclaimOrder`. `ref` is `"<txHash>#<index>"`.
 */
export async function reclaimLpIntent(
  wallet: IWallet,
  ref: string,
): Promise<string> {
  const [txHash, indexStr] = ref.split("#");
  const index = Number(indexStr);
  if (!txHash || !Number.isInteger(index)) {
    throw new Error(`malformed lp-intent ref: ${ref}`);
  }
  // Refuse on a network where the LP-intent path isn't live (also narrows LP_INTENT_REF).
  const { lpIntentRef } = requireLpIntentDeployed();

  const [intent, protocol, changeAddress, collateral, utxos] = await Promise.all([
    fetchUtxo(txHash, index, "lp-intent"),
    fetchProtocolParams(),
    wallet.getChangeAddress(),
    wallet.getCollateral(),
    wallet.getUtxos(),
  ]);
  const { params, costModels } = protocol;
  const ownerPkh = deserializeAddress(changeAddress).pubKeyHash;
  const col = collateral[0];
  if (!col) {
    throw new Error("no collateral in wallet — set a collateral UTXO and retry");
  }
  const fundingUtxos = excludeCollateral(utxos, collateral);

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  // Inject the network's real cost models so the script-integrity hash matches the node.
  txBuilder.setCostModels(costModels);
  const unsignedTx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      intent.input.txHash,
      intent.input.outputIndex,
      intent.output.amount,
      intent.output.address,
      0, // scriptSize: the intent UTXO carries no attached reference script.
    )
    .spendingTxInReference(
      lpIntentRef.txHash,
      lpIntentRef.outputIndex,
      LP_INTENT_SCRIPT_SIZE.toString(),
      lpIntentScriptHash(),
    )
    .spendingReferenceTxInInlineDatumPresent()
    .spendingReferenceTxInRedeemerValue(lpIntentReclaimRedeemer)
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

export interface CreatePoolArgs {
  /** Token A unit ("lovelace" or `policy+name`). */
  assetAUnit: string;
  /** Token B unit. By live convention ADA (`"lovelace"`) when one side is ADA. */
  assetBUnit: string;
  /** Static fee numerator (`0 <= feeNum < feeDen`). */
  feeNum: bigint;
  /** Static fee denominator (`> 0`). */
  feeDen: bigint;
}

export interface CreatePoolResult {
  txHash: string;
  /** The new pool's id (its NFT unit, `policyId + nft_name`) — for the deposit hand-off. */
  poolId: string;
}

/**
 * Build → sign → submit a pool creation (BLUEPRINT §5.1). A standalone, user-driven mint
 * — no solver, no settlement anchor. Pool creation is permissionless (anyone may create a
 * pool). Picks a wallet UTXO as the one-shot `seed`, instantiates the per-pool
 * `pool_mint(seed)` policy client-side (`buildCreatePool`), mints `{NFT:1, LP:total_lp}`
 * under it with the `Create` redeemer, and locks them into a single EMPTY pool UTXO at the
 * shared `POOL_ADDR` with a well-formed inline `PoolDatum`. The creator adds the first
 * liquidity afterward via `depositLiquidity` (a separate tx — the just-created pool can't
 * be spent here).
 *
 * `buildCreatePool` validates + encodes everything (it throws on a malformed intent, so a
 * bad create never reaches the chain). Returns the tx hash and the new pool id (NFT unit).
 */
export async function createPool(
  wallet: IWallet,
  args: CreatePoolArgs,
): Promise<CreatePoolResult> {
  const { params, costModels, changeAddress, col, fundingUtxos } =
    await spendContext(wallet);

  // The creator authorizes the pre-seed ClosePool by SIGNATURE, so the mint policy
  // requires a VK creator (§I-03). Derive it from the change address; reject a
  // script-credential wallet up front (no pubKeyHash).
  const ownerPkh = deserializeAddress(changeAddress).pubKeyHash;
  if (!ownerPkh) {
    throw new Error(
      "pool creation requires a key-based (VK) wallet — this wallet has a script credential",
    );
  }

  // Pick the one-shot seed: prefer a pure-ADA funding UTXO (so we don't drag tokens
  // through change), else any. `fundingUtxos` already excludes collateral; the seed is
  // CONSUMED so it must also be excluded from the funding-selection set below.
  const seedUtxo =
    fundingUtxos.find(
      (u) =>
        u.output.amount.length === 1 &&
        u.output.amount[0]?.unit === "lovelace",
    ) ?? fundingUtxos[0];
  if (!seedUtxo) {
    throw new Error("no funding UTXO available to use as the pool seed");
  }
  const seed = {
    txHash: seedUtxo.input.txHash,
    index: seedUtxo.input.outputIndex,
  };

  const built = buildCreatePool({
    seed,
    ownerPkh,
    assetAUnit: args.assetAUnit,
    assetBUnit: args.assetBUnit,
    feeNum: args.feeNum,
    feeDen: args.feeDen,
  });

  const funding = fundingUtxos.filter(
    (u) =>
      !(u.input.txHash === seed.txHash && u.input.outputIndex === seed.index),
  );

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  // Inject the network's real cost models so the script-integrity hash matches the node.
  txBuilder.setCostModels(costModels);
  const unsignedTx = await txBuilder
    // Consume the seed (a plain wallet input) so the one-shot policy is valid. scriptSize
    // 0: it carries no attached reference script (also keeps complete() from demanding a fetcher).
    .txIn(
      seedUtxo.input.txHash,
      seedUtxo.input.outputIndex,
      seedUtxo.output.amount,
      seedUtxo.output.address,
      0,
    )
    // Mint exactly {NFT:1, LP:total_lp} under the per-seed policy with the Create redeemer.
    // Both mints share one policy + redeemer (MeshJS auto-groups same-policy mints).
    .mintPlutusScriptV3()
    .mint("1", built.policyId, NFT_NAME_HEX)
    .mintingScript(built.script)
    .mintRedeemerValue(mintCreateRedeemer)
    .mintPlutusScriptV3()
    .mint(TOTAL_LP.toString(), built.policyId, LP_NAME_HEX)
    .mintingScript(built.script)
    .mintRedeemerValue(mintCreateRedeemer)
    // ALL minted NFT+LP land in this ONE pool output (none to change), with the inline
    // PoolDatum — `mint.create`'s "NFT + LP in one output" check fails otherwise.
    .txOut(built.address, built.poolValue)
    .txOutInlineDatumValue(built.datum)
    .txInCollateral(
      col.input.txHash,
      col.input.outputIndex,
      col.output.amount,
      col.output.address,
    )
    .changeAddress(changeAddress)
    .selectUtxosFrom(funding)
    .complete();

  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);
  return { txHash, poolId: built.nftUnit };
}

/**
 * Build → sign → submit a teardown of an EMPTY (never-seeded) pool (BLUEPRINT §5.1
 * path c). Only the creator may close, and only while the pool still holds the entire
 * LP supply (`held == total_lp` ⟺ `circ == 0`) — after a first deposit the locked
 * `min_liq` is unreachable and the pool is immortal. Spends the pool UTXO with the
 * `ClosePool` redeemer (via the pool reference script, creator signature required) and
 * burns `{NFT:-1, LP:-total_lp}` under the pool's one-shot policy with the `Close`
 * redeemer; no pool output (it's destroyed) — the ~2 ADA seed returns to the creator as
 * change. The one-shot seed isn't in the datum, so it's recovered from the pool's
 * mint-tx inputs (`recoverSeed`, pure). Returns the tx hash.
 */
export async function closePool(
  wallet: IWallet,
  pool: Pool,
): Promise<LiquidityResult> {
  const { poolRef } = requireDeployed();
  const poolUtxo = await fetchPoolUtxo(pool.id);
  const datumCbor = poolUtxo.output.plutusData;
  if (!datumCbor) throw new Error("pool UTXO has no inline datum");
  const datum = decodePoolDatum(datumCbor);

  // Only an EMPTY pool can be closed: it must still hold the entire LP supply
  // (held == total_lp ⟺ circ == 0). Surface a clear message rather than a validator fail.
  const lpUnit = lpUnitForPool(pool.id);
  const heldLp = poolUtxo.output.amount.find((a) => a.unit === lpUnit);
  if (!heldLp || BigInt(heldLp.quantity) !== TOTAL_LP) {
    throw new Error(
      "pool is not empty — only a never-seeded pool (no liquidity) can be closed",
    );
  }
  if (datum.creator.kind !== "key") {
    throw new Error("pool creator is not a key credential — cannot close");
  }

  const { params, costModels, changeAddress, col, fundingUtxos } =
    await spendContext(wallet);
  const ownerPkh = deserializeAddress(changeAddress).pubKeyHash;
  if (ownerPkh !== datum.creator.hash) {
    throw new Error("only the pool creator can close this pool");
  }

  // The one-shot seed isn't on-chain in the datum — recover it from the pool's mint-tx
  // inputs (the input that reproduces this pool's policy id), then build the burn policy.
  const candidates = await fetchPoolMintInputs(pool.id);
  const seed = recoverSeed(pool.id, candidates);
  const built = buildClosePool({ nftUnit: pool.id, seed, creatorPkh: ownerPkh });

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  // Inject the network's real cost models so the script-integrity hash matches the node.
  txBuilder.setCostModels(costModels);
  const unsignedTx = await txBuilder
    // Spend the pool UTXO with ClosePool via the pool reference script. No pool output —
    // the pool is destroyed; its ~2 ADA (+ the freed NFT/LP burned below) → creator change.
    .spendingPlutusScriptV3()
    .txIn(
      poolUtxo.input.txHash,
      poolUtxo.input.outputIndex,
      poolUtxo.output.amount,
      poolUtxo.output.address,
      0, // scriptSize: the pool UTXO carries no attached reference script.
    )
    .spendingTxInReference(
      poolRef.txHash,
      poolRef.outputIndex,
      POOL_SCRIPT_SIZE.toString(),
      POOL_SCRIPT_HASH,
    )
    .spendingReferenceTxInInlineDatumPresent()
    .spendingReferenceTxInRedeemerValue(closePoolRedeemer)
    // Burn the NFT + full LP supply under the seed-applied policy (Close redeemer). Both
    // burns share one policy + redeemer (MeshJS auto-groups same-policy mints).
    .mintPlutusScriptV3()
    .mint("-1", built.policyId, NFT_NAME_HEX)
    .mintingScript(built.script)
    .mintRedeemerValue(mintCloseRedeemer)
    .mintPlutusScriptV3()
    .mint((-TOTAL_LP).toString(), built.policyId, LP_NAME_HEX)
    .mintingScript(built.script)
    .mintRedeemerValue(mintCloseRedeemer)
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
  const { poolRef } = requireDeployed();
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

  const { params, costModels, changeAddress, col, fundingUtxos } =
    await spendContext(wallet);

  // Preflight: the recreated pool output needs `lpToBurn` more LP than the pool input
  // carries, so the wallet must supply it via coin selection. Surface a clear error up
  // front rather than an opaque "not enough UTxOs" from the balancer (mirrors 08's assert).
  const lpUnit = lpUnitForPool(args.pool.id);
  const walletLp = fundingUtxos.reduce((sum, u) => {
    const a = u.output.amount.find((x) => x.unit === lpUnit);
    return sum + (a ? BigInt(a.quantity) : 0n);
  }, 0n);
  if (walletLp < args.lpToBurn) {
    throw new Error(
      `wallet holds ${walletLp} LP for this pool — not enough to burn ${args.lpToBurn}`,
    );
  }

  const txBuilder = new MeshTxBuilder({ params, evaluator });
  // Inject the network's real cost models so the script-integrity hash matches the node.
  txBuilder.setCostModels(costModels);
  const unsignedTx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      poolUtxo.input.txHash,
      poolUtxo.input.outputIndex,
      poolUtxo.output.amount,
      poolUtxo.output.address,
      0, // scriptSize: the pool UTXO carries no attached reference script (out.reference_script == None). Required so MeshTxBuilder.complete() doesn't demand a fetcher to resolve it.
    )
    .spendingTxInReference(
      poolRef.txHash,
      poolRef.outputIndex,
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
