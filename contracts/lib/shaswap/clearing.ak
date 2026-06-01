//// The curve-agnostic settlement check (BLUEPRINT §5.2/§5.4), run once per tx by
//// the unparameterised withdraw-0 settlement validator.
////
//// Enumerates the protocol input set by the stake-credential tag `S`, classifies
//// each tagged input by datum shape (parses-as-OrderDatum => order; the sole
//// non-order => the pool), and enforces uniform price, per-order floor, the
//// injective O(N) positional order->output binding, deadlines, and partial fills.
//// Orders are **bidirectional**: token->ADA and ADA->token orders clear at one
//// price and **net** against each other; only the residual hits the pool.
////
//// **Partial fills (proportional tip).** The solver declares each order's fill
//// `f` in `redeemer.fills`. `f == sell_amount` is a full fill (owner output only).
//// `f < sell_amount` requires `partial == True` and produces a **remainder UTXO**
//// re-locked at the order's own address (tagged `S`, `partial == False` — one
//// level) holding the unsold asset + a pre-funded min-ADA + the leftover tip
//// `tip − tip·f/sell`; the solver collects `tip·f/sell` now. The pre-funded second
//// min-ADA (which on a full fill simply returns to the owner) funds the remainder.
////
//// It does NOT check `k` (pool validator's job, §5.4) and never parses PoolDatum.
//// Safety without a global-conservation pass: every owner output, every remainder,
//// and the pool are pinned exactly, `mint == 0`, and ledger value conservation then
//// forces the solver to take only the (proportional) tips.

use aiken/collection/list
use aiken/interval.{Finite, Interval}
use cardano/address.{Credential}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use shaswap/constants.{order_min_ada}
use shaswap/types.{BoundDatum, OrderDatum, SettlementRedeemer}
use shaswap/utils

fn parses_as_order(i: Input) -> Bool {
  when i.output.datum is {
    InlineDatum(d) ->
      if d is _o: OrderDatum {
        True
      } else {
        False
      }
    _ -> False
  }
}

/// The tx's finite upper validity bound, if any (None if open-ended).
fn finite_upper(range: Interval) -> Option<Int> {
  when range.upper_bound.bound_type is {
    Finite(u) -> Some(u)
    _ -> None
  }
}

/// An order with a deadline can only be settled while the tx is bounded to end
/// no later than the deadline (an open-ended tx can't honor it).
fn deadline_ok(deadline: Option<Int>, tx_upper: Option<Int>) -> Bool {
  when deadline is {
    None -> True
    Some(d) ->
      when tx_upper is {
        Some(u) -> u <= d
        None -> False
      }
  }
}

/// Verify and consume the head remainder UTXO for a partially-filled order. It
/// must sit at the order's own address (so it stays a reclaimable order tagged
/// `S`), hold exactly the unsold asset + pre-funded min-ADA + leftover tip, and
/// carry a one-level (`partial == False`) order datum that preserves the owner,
/// direction, deadline, and the limit *price* (`limit'·sell ≥ limit·sell'`).
fn consume_remainder(
  remainders: List<Output>,
  order: OrderDatum,
  new_sell: Int,
  tip_rem: Int,
  exp_value: Value,
  order_addr,
) -> List<Output> {
  expect [rem, ..rest] = remainders
  expect rem.address == order_addr
  // full-value pin: the remainder holds EXACTLY the unsold asset + pre-funded
  // min-ADA + leftover tip and nothing else (no junk asset rides along to the
  // solver, and the unsold side can't be shorted).
  expect rem.value == exp_value
  expect InlineDatum(rd) = rem.datum
  expect ro: OrderDatum = rd
  expect ro.owner == order.owner
  expect ro.sell_a == order.sell_a
  expect ro.sell_amount == new_sell
  expect ro.tip == tip_rem
  expect !ro.partial
  expect ro.deadline == order.deadline
  // limit price preserved or improved (never fills worse than the original)
  expect ro.limit * order.sell_amount >= order.limit * new_sell
  rest
}

/// Per-order check at the uniform price. Returns the order's signed contribution
/// to the pool's net reserve movement `(d_a, d_b)` (in `asset_a`/`asset_b`) and the
/// remainders list with this order's remainder (if partial) consumed.
fn check_one(
  input: Input,
  bound: Output,
  f: Int,
  remainders: List<Output>,
  r: SettlementRedeemer,
  tx_upper: Option<Int>,
) -> (Int, Int, List<Output>) {
  expect InlineDatum(od) = input.output.datum
  expect order: OrderDatum = od

  expect deadline_ok(order.deadline, tx_upper)
  // (6) injective binding: this output is bound to THIS order's unique ref
  expect InlineDatum(bd) = bound.datum
  expect b: BoundDatum = bd
  expect b.order_ref == input.output_reference
  expect bound.address.payment_credential == order.owner

  expect f >= 1
  expect f <= order.sell_amount
  let is_partial = f < order.sell_amount
  // partial fills require the order to allow them
  expect or {
      !is_partial,
      order.partial,
    }

  let in_val = input.output.value
  let unsold = order.sell_amount - f
  // proportional tip: solver takes tip·f/sell now, remainder keeps the rest
  let tip_taken = order.tip * f / order.sell_amount
  let tip_rem = order.tip - tip_taken
  let min_to_rem = if is_partial {
    order_min_ada
  } else {
    0
  }

  // price p = asset_b per asset_a. Resolve the order's sold/bought asset, the
  // amount received, the signed pool contribution `(d_a, d_b)`, and the per-order
  // floor (§5.2.5) honored at the full-fill floor (independent of f).
  let (sold, bought, received, d_a, d_b, floor_ok) = if order.sell_a {
    // sells asset_a, buys asset_b: received_b = f·num/den
    let recv = f * r.price_num / r.price_den
    (
      r.asset_a,
      r.asset_b,
      recv,
      f,
      -recv,
      order.sell_amount * r.price_num >= order.limit * r.price_den,
    )
  } else {
    // sells asset_b, buys asset_a: received_a = f·den/num
    let recv = f * r.price_den / r.price_num
    (
      r.asset_b,
      r.asset_a,
      recv,
      -recv,
      f,
      order.sell_amount * r.price_den >= order.limit * r.price_num,
    )
  }
  expect floor_ok

  // (1) full-value pin: owner gets the input minus ALL the sold asset (the unsold
  // part reappears in the remainder), plus the bought asset, minus the tip taken
  // and — on a partial — the one min-ADA that funds the remainder. Any incidental
  // asset rides through to the owner, never the solver; works whether sold/bought
  // is ADA or a token (those deltas just land on the lovelace field).
  let owner_val = in_val
    |> assets.add(sold.policy, sold.name, -order.sell_amount)
    |> assets.add(bought.policy, bought.name, received)
    |> ada_add(-(order.tip + min_to_rem))
  expect bound.value == owner_val

  if is_partial {
    // remainder holds the unsold sold-asset + pre-funded min-ADA + leftover tip
    let rem_val = assets.from_lovelace(order_min_ada + tip_rem)
      |> assets.add(sold.policy, sold.name, unsold)
    let rest = consume_remainder(
      remainders,
      order,
      unsold,
      tip_rem,
      rem_val,
      input.output.address,
    )
    (d_a, d_b, rest)
  } else {
    (d_a, d_b, remainders)
  }
}

/// Add a (signed) lovelace delta to a value (preserving every other asset).
fn ada_add(v: Value, delta: Int) -> Value {
  assets.add(v, ada_policy_id, ada_asset_name, delta)
}

/// Process every order (zipped with its owner output and fill), threading the
/// remainders list. Returns the pool's net `(token, ada)` movement; asserts that
/// fills and remainders are exactly consumed (no extras).
fn process(
  pairs: List<(Input, Output)>,
  fills: List<Int>,
  remainders: List<Output>,
  r: SettlementRedeemer,
  tx_upper: Option<Int>,
) -> (Int, Int) {
  when pairs is {
    [] -> {
      expect [] = fills
      expect [] = remainders
      (0, 0)
    }
    [(input, bound), ..rest] -> {
      expect [f, ..frest] = fills
      let (d_a, d_b, rem2) = check_one(input, bound, f, remainders, r, tx_upper)
      let (na, nb) = process(rest, frest, rem2, r, tx_upper)
      (d_a + na, d_b + nb)
    }
  }
}

pub fn run(account: Credential, r: SettlementRedeemer, tx: Transaction) -> Bool {
  // the two declared assets must be distinct (a degenerate `asset_a == asset_b`
  // would collapse the pair). Either may be ADA; at most one can be.
  expect r.asset_a != r.asset_b

  // (7) enumerate the protocol input set by the stake tag S = our own credential
  let tagged_inputs = list.filter(
    tx.inputs,
    fn(i) { utils.is_tagged(i.output, account) },
  )

  // orders parse as OrderDatum; the sole non-order tagged input is the pool. A
  // real order can never be mis-roled as the pool (§5.4).
  let (order_inputs, pool_inputs) = list.partition(
    tagged_inputs,
    parses_as_order,
  )
  expect [pool_in] = pool_inputs

  expect utils.asset_qty(pool_in.output.value, r.pool_nft) == 1

  // tagged outputs = the pool (carries the NFT) + remainder UTXOs (no NFT).
  let tagged_outputs = list.filter(
    tx.outputs,
    fn(o) { utils.is_tagged(o, account) },
  )
  let (pool_outs, remainders) = list.partition(
    tagged_outputs,
    fn(o) { utils.asset_qty(o.value, r.pool_nft) == 1 },
  )
  expect [pool_out] = pool_outs
  expect pool_out.address == pool_in.output.address

  // (6) O(N) positional binding: owner-outputs are the first N outputs in
  // canonical (input) order; remainders follow the pool.
  let n = list.length(order_inputs)
  let owner_outputs = list.take(tx.outputs, n)
  expect list.length(owner_outputs) == n
  let tx_upper = finite_upper(tx.validity_range)
  let (net_a, net_b) = process(
    list.zip(order_inputs, owner_outputs),
    r.fills,
    remainders,
    r,
    tx_upper,
  )

  // no minting/burning in a settlement (LP mint only at create/close)
  expect assets.is_zero(tx.mint)

  // (1) the pool absorbs EXACTLY the net residual and nothing else. Pinning the
  // pool output as the input value shifted by `(net_a, net_b)` preserves its NFT,
  // held LP, min-ADA overhead, and any incidental asset automatically — so a solver
  // can't strip the pool's LP (then drain via `LpAction`) or skim reserves. Together
  // with per-order/per-remainder full-value pins, `mint == 0`, and ledger value
  // conservation, the solver can take only the proportional tips — no separate
  // global-conservation pass needed.
  let pool_val_exp = pool_in.output.value
    |> assets.add(r.asset_a.policy, r.asset_a.name, net_a)
    |> assets.add(r.asset_b.policy, r.asset_b.name, net_b)
  expect pool_out.value == pool_val_exp
  // pool identity/params (and curve state) can't be mutated mid-settlement
  expect pool_out.datum == pool_in.output.datum

  // NB: k_after >= k_before is enforced by the POOL validator (§5.4 split).
  True
}
