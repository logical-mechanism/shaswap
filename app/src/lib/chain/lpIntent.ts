/**
 * Pure builders for the two batcher-fulfilled LP intents (BLUEPRINT §5.1/§5.4 Rev 22,
 * `documentation/spec/lp-intents.md`): the inline `LpIntentDatum`, the output value, and
 * the `lp_intent` ENTERPRISE address. Side-effect-free — the wallet/tx wiring lives in
 * `lib/client/tx.ts`; this is the encoding + value layout + strict validation, so it is
 * unit-testable and a malformed intent is *rejected here*, never silently posted.
 *
 * Mirrors `buildOrder`: the owner is the wallet's payment key hash (so the intent is
 * owner-reclaimable — the non-custodial guarantee), `owner_stake` is pinned from the datum
 * (the batcher can't redirect the payout's staking rewards, audit M-01), and the value
 * carries the per-UTXO `lp_intent_min_ada` + the solver tip.
 *
 * Value layout (mirrors the on-chain spec §"Intent value"):
 *  - **Withdraw** intent holds `L` LP tokens + (`lp_intent_min_ada + tip`) lovelace.
 *  - **Deposit**  intent holds `dA` of asset_a + `dB` of asset_b + lovelace. When a pool side
 *    is ADA, that side's deposit rides IN the lovelace alongside the tip + min-ADA (the
 *    §5.2.1 ADA triple-role): `lovelace = lp_intent_min_ada + tip + (ADA-side deposit)`.
 *
 * No script runs at creation — posting is a plain payment to the `lp_intent` address with an
 * inline datum (the address is enterprise / stake = None, so the settlement anchor never
 * enumerates it). The floors (`min_shares` for deposit, `min_a`/`min_b` for withdraw) come
 * from a conservative quote (`lpQuote.ts`) so an honest batcher can always fulfill the intent.
 */

import type { Asset, Data } from "@meshsdk/core";
import {
  assetFromUnit,
  assetUnit,
  type Credential,
  encodeLpIntentDatum,
  isAda,
  type LpIntentDatum,
} from "./datums.ts";
import {
  DEPLOYMENT_NETWORK_ID,
  LP_INTENT_MIN_ADA,
  lpUnitForPool,
} from "./deployment.ts";
import { lpIntentAddress } from "./lpIntentScript.ts";

const HEX28 = /^[0-9a-fA-F]{56}$/;

/** Fields common to both intent shapes. */
interface LpIntentBase {
  /** Owner = the wallet's payment key hash (28-byte hex). MUST be a vkey (reclaim). */
  ownerPkh: string;
  /**
   * The owner's stake credential for the payout, or `null` for an enterprise payout. Pinned
   * from the datum so the batcher can't redirect it (audit M-01). Usually the wallet's own
   * reward-address stake cred (a base-address payout the wallet displays + can spend).
   */
  ownerStake: Credential | null;
  /** Pool NFT unit (`policy+name`) the intent consents to — its identity binding. */
  poolNftUnit: string;
  /** The pool's pair, by unit ("lovelace" or `policy+name`). */
  assetAUnit: string;
  assetBUnit: string;
  /** Solver tip, in lovelace (the only value the batcher keeps). */
  tip: bigint;
  /** Optional fulfillment deadline (POSIX ms). */
  deadline: bigint | null;
}

/** A deposit intent: add `amountA`/`amountB`, receive ≥ `minShares` LP. */
export interface LpIntentDepositIntent extends LpIntentBase {
  /** Amount of `asset_a` to deposit (base units). */
  amountA: bigint;
  /** Amount of `asset_b` to deposit (base units). */
  amountB: bigint;
  /** Owner floor: minimum LP shares minted (from a conservative quote). */
  minShares: bigint;
}

/** A withdraw intent: redeem `lpAmount` LP, receive ≥ `minA`/`minB` of the reserves. */
export interface LpIntentWithdrawIntent extends LpIntentBase {
  /** LP tokens to redeem (base units), `L ≥ 1`. */
  lpAmount: bigint;
  /** Owner floor: minimum released `asset_a` (from a conservative quote). */
  minA: bigint;
  /** Owner floor: minimum released `asset_b`. */
  minB: bigint;
}

export interface BuiltLpIntent {
  /** Where to send it — the `lp_intent` enterprise address (stake = None). */
  address: string;
  /** The inline `LpIntentDatum` as Mesh `Data` (default "Mesh" type). */
  datum: Data;
  /** The output value (the intent UTXO). */
  value: Asset[];
  /** The structured datum (handy for display / tests). */
  lpIntentDatum: LpIntentDatum;
}

/** Shared validation of the owner + pair + tip + deadline. Throws on anything malformed. */
function validateBase(b: LpIntentBase): void {
  if (!HEX28.test(b.ownerPkh)) {
    throw new Error("LP-intent owner must be a 28-byte payment key hash (vkey)");
  }
  if (b.ownerStake !== null && !HEX28.test(b.ownerStake.hash)) {
    throw new Error("owner stake credential must be a 28-byte hash");
  }
  if (b.assetAUnit === b.assetBUnit) {
    throw new Error("pool pair assets must differ");
  }
  // The tip is the ONLY solver reward — a 0-tip intent has no incentive and no batcher will
  // ever fulfill it, so reject it client-side rather than post a stuck (only-reclaimable) intent.
  if (b.tip <= 0n) throw new Error("tip must be positive (the only solver reward)");
  if (b.deadline !== null && b.deadline <= 0n) {
    throw new Error("deadline, if set, must be a positive POSIX timestamp");
  }
}

/** The owner credential, normalised to lower-case hex. */
function ownerCred(b: LpIntentBase): Credential {
  return { kind: "key", hash: b.ownerPkh.toLowerCase() };
}

function ownerStakeCred(b: LpIntentBase): Credential | null {
  return b.ownerStake === null
    ? null
    : { kind: b.ownerStake.kind, hash: b.ownerStake.hash.toLowerCase() };
}

/**
 * Validate + build a DEPOSIT intent. The intent locks `amountA` of asset_a + `amountB` of
 * asset_b + (`lp_intent_min_ada + tip`) lovelace, with the ADA-side deposit (if any) folded
 * into that lovelace. Throws on any malformed intent (never posts garbage).
 */
export function buildLpIntentDeposit(intent: LpIntentDepositIntent): BuiltLpIntent {
  validateBase(intent);
  const { assetAUnit, assetBUnit, amountA, amountB, minShares, tip, poolNftUnit } = intent;

  if (amountA <= 0n || amountB <= 0n) {
    throw new Error("deposit amounts must be positive on both sides");
  }
  // The owner floor is the slippage guard. A non-positive floor would let the batcher mint as
  // few as 1 share — defeating slippage protection — so require the app to pass a real floor.
  if (minShares <= 0n) {
    throw new Error("deposit min_shares (slippage floor) must be positive");
  }

  const assetA = assetFromUnit(assetAUnit);
  const assetB = assetFromUnit(assetBUnit);

  const lpIntentDatum: LpIntentDatum = {
    owner: ownerCred(intent),
    ownerStake: ownerStakeCred(intent),
    poolNft: assetFromUnit(poolNftUnit),
    action: "deposit",
    minA: 0n, // ignored for deposit
    minB: 0n,
    minShares,
    tip,
    deadline: intent.deadline,
  };

  // lovelace carries min-ADA + tip, plus the ADA-side deposit when a pool side is ADA (the
  // triple-role). The token side(s) ride as their own asset entries.
  let lovelace = LP_INTENT_MIN_ADA + tip;
  const tokens: Asset[] = [];
  if (isAda(assetA)) lovelace += amountA;
  else tokens.push({ unit: assetUnit(assetA), quantity: amountA.toString() });
  if (isAda(assetB)) lovelace += amountB;
  else tokens.push({ unit: assetUnit(assetB), quantity: amountB.toString() });

  const value: Asset[] = [{ unit: "lovelace", quantity: lovelace.toString() }, ...tokens];
  return {
    address: lpIntentAddress(DEPLOYMENT_NETWORK_ID),
    datum: encodeLpIntentDatum(lpIntentDatum),
    value,
    lpIntentDatum,
  };
}

/**
 * Validate + build a WITHDRAW intent. The intent locks `lpAmount` LP tokens +
 * (`lp_intent_min_ada + tip`) lovelace. Throws on any malformed intent (never posts garbage).
 *
 * Honest residual (§13): reclaiming a withdraw intent returns the LP tokens, NOT the
 * underlying — turning LP back into reserves is a pool mutation, the very contention this
 * path routes around. The UI states this.
 */
export function buildLpIntentWithdraw(intent: LpIntentWithdrawIntent): BuiltLpIntent {
  validateBase(intent);
  const { lpAmount, minA, minB, tip, poolNftUnit } = intent;

  if (lpAmount < 1n) throw new Error("withdraw LP amount must be at least 1");
  if (minA < 0n || minB < 0n) throw new Error("withdraw floors must be non-negative");
  // A withdraw with no floor on either side gives the owner zero slippage protection (an
  // honest batcher still pays fair, but a tight floor is the documented mitigation, §13).
  if (minA <= 0n && minB <= 0n) {
    throw new Error("withdraw needs a positive floor on at least one side");
  }

  const lpIntentDatum: LpIntentDatum = {
    owner: ownerCred(intent),
    ownerStake: ownerStakeCred(intent),
    poolNft: assetFromUnit(poolNftUnit),
    action: "withdraw",
    minA,
    minB,
    minShares: 0n, // ignored for withdraw
    tip,
    deadline: intent.deadline,
  };

  const value: Asset[] = [
    { unit: "lovelace", quantity: (LP_INTENT_MIN_ADA + tip).toString() },
    { unit: lpUnitForPool(poolNftUnit), quantity: lpAmount.toString() },
  ];
  return {
    address: lpIntentAddress(DEPLOYMENT_NETWORK_ID),
    datum: encodeLpIntentDatum(lpIntentDatum),
    value,
    lpIntentDatum,
  };
}
