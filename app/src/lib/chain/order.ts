/**
 * Build a ShaSwap order from a user intent: the inline `OrderDatum`, the output value,
 * and the (stake-tagged) order address. Pure and side-effect-free — the wallet/tx
 * wiring lives in `lib/client/tx.ts`; this is the encoding + the value layout +
 * strict validation, so it is unit-testable and a malformed order is *rejected here*,
 * never silently posted.
 *
 * Value layout (mirrors `happy_path/05-post-order.sh` + `05b-post-ada-order.sh`):
 *  - the order holds the sold asset, the per-UTXO min-ADA, and the solver tip;
 *  - when the sold asset IS ADA, all three are lovelace (the §5.2.1 ADA triple-role):
 *    `lovelace = sellAmount + min-ADA + tip`;
 *  - otherwise `lovelace = min-ADA + tip` and the token rides as its own asset.
 *
 * Partial fills need a SECOND `order_min_ada`: on a partial, the settlement validator
 * moves one `order_min_ada` from the owner output into the remainder UTXO
 * (`clearing.ak` `min_to_rem`), so a `partial` order pre-funds `2× order_min_ada` —
 * the spare simply returns to the owner on a full fill. Without it an ADA-seller
 * partial fill would leave a 0-lovelace owner output (unsettleable). A full-fill-only
 * order uses `1× order_min_ada`.
 *
 * No script runs at creation — posting is a plain payment to the order address with
 * an inline datum. The stake tag `S` is baked into `ORDER_ADDR`, so the UTXO is
 * automatically delegated to the settlement anchor (BLUEPRINT §5.4).
 */

import type { Asset, Data } from "@meshsdk/core";
import {
  assetFromUnit,
  assetUnit,
  type Credential,
  encodeOrderDatum,
  isAda,
  type OrderDatum,
} from "./datums.ts";
import { ORDER_ADDR, ORDER_MIN_ADA } from "./deployment.ts";

/** The connected wallet's intent, in base units. */
export interface OrderIntent {
  /** Owner = the wallet's payment key hash (28-byte hex). MUST be a vkey (reclaim). */
  ownerPkh: string;
  /**
   * The owner's stake credential for the settled-funds payout, or `null` for an
   * enterprise payout. Non-null makes the payout a **base** address (so Lace-style
   * wallets display + spend it). Usually the wallet's own reward-address stake cred.
   */
  ownerStake: Credential | null;
  /** Pool NFT unit (`policy+name`) the order consents to — its identity binding. */
  poolNftUnit: string;
  /** The pool's pair, by unit ("lovelace" or `policy+name`). */
  assetAUnit: string;
  assetBUnit: string;
  /** The asset being sold — must equal `assetAUnit` or `assetBUnit`. */
  sellUnit: string;
  /** Amount of `sellUnit` to sell. */
  sellAmount: bigint;
  /** Per-order floor: the minimum amount of the *bought* asset (§5.2.5). */
  limit: bigint;
  /** Solver tip, in lovelace (the only solver reward). */
  tip: bigint;
  /** Allow partial fills (a one-level remainder UTXO). */
  partial: boolean;
  /** Optional settlement deadline (POSIX ms). */
  deadline: bigint | null;
}

export interface BuiltOrder {
  /** Where to send it — the `S`-tagged order address. */
  address: string;
  /** The inline `OrderDatum` as Mesh `Data` (default "Mesh" type). */
  datum: Data;
  /** The output value. */
  value: Asset[];
  /** The structured datum (handy for display / tests). */
  orderDatum: OrderDatum;
}

const HEX28 = /^[0-9a-fA-F]{56}$/;

/** Validate + build an order. Throws on any malformed intent (never posts garbage). */
export function buildOrder(intent: OrderIntent): BuiltOrder {
  const {
    ownerPkh,
    ownerStake,
    poolNftUnit,
    assetAUnit,
    assetBUnit,
    sellUnit,
    sellAmount,
    limit,
    tip,
    partial,
    deadline,
  } = intent;

  if (!HEX28.test(ownerPkh)) {
    throw new Error("order owner must be a 28-byte payment key hash (vkey)");
  }
  if (ownerStake !== null && !HEX28.test(ownerStake.hash)) {
    throw new Error("owner stake credential must be a 28-byte hash");
  }
  if (assetAUnit === assetBUnit) {
    throw new Error("pool pair assets must differ");
  }
  if (sellUnit !== assetAUnit && sellUnit !== assetBUnit) {
    throw new Error("sell asset must be one side of the pool pair");
  }
  if (sellAmount <= 0n) throw new Error("sell amount must be positive");
  if (limit <= 0n) throw new Error("limit (floor) must be positive");
  if (tip < 0n) throw new Error("tip must be non-negative");
  if (deadline !== null && deadline <= 0n) {
    throw new Error("deadline, if set, must be a positive POSIX timestamp");
  }

  const sellA = sellUnit === assetAUnit;
  const sold = assetFromUnit(sellUnit);

  const orderDatum: OrderDatum = {
    owner: { kind: "key", hash: ownerPkh.toLowerCase() },
    ownerStake:
      ownerStake === null
        ? null
        : { kind: ownerStake.kind, hash: ownerStake.hash.toLowerCase() },
    poolNft: assetFromUnit(poolNftUnit),
    sellA,
    sellAmount,
    limit,
    tip,
    partial,
    deadline,
  };

  // Value: min-ADA + tip (+ the sold ADA, if selling ADA) as lovelace; token aside.
  // Partial orders pre-fund a second order_min_ada to fund the remainder UTXO.
  const minAda = partial ? ORDER_MIN_ADA * 2n : ORDER_MIN_ADA;
  const lovelace = minAda + tip + (isAda(sold) ? sellAmount : 0n);
  const value: Asset[] = [{ unit: "lovelace", quantity: lovelace.toString() }];
  if (!isAda(sold)) {
    value.push({ unit: assetUnit(sold), quantity: sellAmount.toString() });
  }

  return { address: ORDER_ADDR, datum: encodeOrderDatum(orderDatum), value, orderDatum };
}
