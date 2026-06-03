/**
 * Tests for the order ADA-funding math (`orderFunding.ts`): the spendable amount and the
 * over-balance / over-spendable / insufficient-ADA blockers that gate the swap card's
 * Post button. These guard the trickiest arithmetic in the swap flow — ADA's three roles
 * (traded / min-ADA / tip) and the partial 2× min-ADA — so a regression here would let
 * the card build a tx the wallet can't submit. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_FEE_BUFFER,
  orderFunding,
  type OrderFundingInput,
} from "./orderFunding.ts";
import { ORDER_MIN_ADA } from "./deployment.ts";

const ADA = 1_000_000n; // 1 ₳ in lovelace
const TIP = 2n * ADA;

/** A full input with sensible defaults; override per case. */
function input(over: Partial<OrderFundingInput> = {}): OrderFundingInput {
  return {
    fromIsAda: false,
    fromBalance: 0n,
    lovelace: 0n,
    partial: false,
    tip: TIP,
    amount: 0n,
    ...over,
  };
}

test("overhead constants: non-partial vs partial min-ADA + fee buffer", () => {
  const full = orderFunding(input());
  assert.equal(full.orderMinAda, ORDER_MIN_ADA);
  assert.equal(full.adaNeeded, ORDER_MIN_ADA + ORDER_FEE_BUFFER);
  assert.equal(full.adaForOrder, ORDER_MIN_ADA + ORDER_FEE_BUFFER + TIP);

  const part = orderFunding(input({ partial: true }));
  assert.equal(part.orderMinAda, 2n * ORDER_MIN_ADA);
  assert.equal(part.adaNeeded, 2n * ORDER_MIN_ADA + ORDER_FEE_BUFFER);
  assert.equal(part.adaForOrder, 2n * ORDER_MIN_ADA + ORDER_FEE_BUFFER + TIP);
});

test("selling ADA: spendable = balance − (min-ADA + fee + tip)", () => {
  const balance = 100n * ADA;
  const f = orderFunding(input({ fromIsAda: true, fromBalance: balance }));
  // reserve = order_min_ada + fee buffer + tip (the tip is also ADA here)
  assert.equal(f.adaReserve, ORDER_MIN_ADA + ORDER_FEE_BUFFER + TIP);
  assert.equal(f.spendable, balance - f.adaReserve);
});

test("selling ADA: spendable floors at 0 when balance ≤ the reserve", () => {
  // balance below the reserve → 0 spendable (MAX can't build an un-submittable tx)
  const f = orderFunding(input({ fromIsAda: true, fromBalance: ORDER_MIN_ADA }));
  assert.equal(f.spendable, 0n);
});

test("selling ADA: a partial order reserves a second min-ADA", () => {
  const balance = 100n * ADA;
  const full = orderFunding(input({ fromIsAda: true, fromBalance: balance }));
  const part = orderFunding(input({ fromIsAda: true, fromBalance: balance, partial: true }));
  assert.equal(part.spendable, full.spendable - ORDER_MIN_ADA);
});

test("selling a token: the whole token balance is spendable (ADA is separate)", () => {
  const f = orderFunding(input({ fromIsAda: false, fromBalance: 500n, lovelace: 100n * ADA }));
  assert.equal(f.spendable, 500n);
});

// ---- the three blockers (connectivity-agnostic; caller ANDs with `connected`) ----

test("no amount → no blockers fire", () => {
  const f = orderFunding(input({ fromIsAda: true, fromBalance: 1n, amount: 0n }));
  assert.equal(f.overBalance, false);
  assert.equal(f.overSpendable, false);
  assert.equal(f.insufficientAda, false);
});

test("overBalance: amount exceeds the raw FROM balance (and suppresses overSpendable)", () => {
  const f = orderFunding(
    input({ fromIsAda: false, fromBalance: 100n, lovelace: 100n * ADA, amount: 101n }),
  );
  assert.equal(f.overBalance, true);
  assert.equal(f.overSpendable, false); // over-balance takes precedence
});

test("overSpendable: within balance but inside the held-back ADA reserve", () => {
  const balance = 5n * ADA; // small ADA balance
  const f = orderFunding(input({ fromIsAda: true, fromBalance: balance, amount: balance }));
  // amount == balance is NOT over balance, but it IS over spendable (reserve carved out)
  assert.equal(f.overBalance, false);
  assert.equal(f.overSpendable, true);
});

test("insufficientAda: selling a token without the ADA to fund min-ADA + fee + tip", () => {
  const short = orderFunding(
    input({ fromIsAda: false, fromBalance: 1000n, lovelace: ORDER_MIN_ADA, amount: 10n }),
  );
  assert.equal(short.insufficientAda, true);

  const ok = orderFunding(
    input({
      fromIsAda: false,
      fromBalance: 1000n,
      lovelace: ORDER_MIN_ADA + ORDER_FEE_BUFFER + TIP,
      amount: 10n,
    }),
  );
  assert.equal(ok.insufficientAda, false);
});

test("insufficientAda never fires when selling ADA (overhead is in `spendable`)", () => {
  const f = orderFunding(input({ fromIsAda: true, fromBalance: 1n, lovelace: 1n, amount: 1n }));
  assert.equal(f.insufficientAda, false);
});
