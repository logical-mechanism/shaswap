//// The curve-agnostic settlement check (BLUEPRINT §5.2/§5.4), run once per tx by
//// the unparameterised withdraw-0 settlement validator.
////
//// Enumerates the protocol input set by the stake-credential tag `S` (= the
//// withdraw purpose's own credential), classifies each tagged input by datum
//// shape (parses-as-OrderDatum => order; the sole non-order => the pool), and
//// enforces conservation, uniform price, per-order floor, and the injective O(N)
//// positional order->output binding. It does NOT check `k` — that is the pool
//// validator's job (§5.4 responsibility split) — and never parses the PoolDatum,
//// so it stays curve-agnostic: the traded token is solver-declared and verified
//// by conservation; the pool NFT is verified by continuity.

use aiken/collection/list
use cardano/address.{Credential}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
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

/// Per-order checks; returns (sold, received, tip) to accumulate. Aborts on any
/// violation (default-deny). `bound` is the positionally-paired owner-output.
fn check_order(
  input: Input,
  bound: Output,
  r: SettlementRedeemer,
) -> (Int, Int, Int) {
  expect InlineDatum(od) = input.output.datum
  expect order: OrderDatum = od
  let in_lovelace = assets.lovelace_of(input.output.value)

  // (6) injective binding: this output is bound to THIS order's unique ref
  expect InlineDatum(bd) = bound.datum
  expect b: BoundDatum = bd
  expect b.order_ref == input.output_reference

  // (2)/(4) uniform price best-response (integer floor — no floats)
  let received = order.sell_amount * r.price_num / r.price_den
  // (5) per-order floor: never worse than the order's own limit
  expect received >= order.limit
  // owner-output goes to the owner; (1) ADA roles: keeps min-ada, gains
  // `received` (traded-ADA), tip removed (-> solver). Buys ADA, so no token out.
  expect bound.address.payment_credential == order.owner
  expect assets.lovelace_of(bound.value) == in_lovelace - order.tip + received
  expect utils.asset_qty(bound.value, r.token) == 0

  (order.sell_amount, received, order.tip)
}

fn process_orders(
  orders: List<Input>,
  owner_outputs: List<Output>,
  r: SettlementRedeemer,
) -> (Int, Int, Int) {
  list.foldl(
    list.zip(orders, owner_outputs),
    (0, 0, 0),
    fn(pair, acc) {
      let (ss, sr, st) = acc
      let (input, bound) = pair
      let (sold, recv, tip) = check_order(input, bound, r)
      (ss + sold, sr + recv, st + tip)
    },
  )
}

pub fn run(account: Credential, r: SettlementRedeemer, tx: Transaction) -> Bool {
  // (7) enumerate the protocol input set by the stake tag S = our own credential
  let tagged_inputs = list.filter(
    tx.inputs,
    fn(i) { utils.is_tagged(i.output, account) },
  )

  // role identification: orders parse as OrderDatum; the sole non-order is the
  // pool. A real order can never be mis-roled as the pool (it parses as order),
  // closing the relabel-and-drain deferral path (§5.4).
  let (order_inputs, pool_inputs) = list.partition(
    tagged_inputs,
    parses_as_order,
  )
  expect [pool_in] = pool_inputs

  // pool input carries the declared NFT (qty 1); reserves from value (k unread)
  expect utils.asset_qty(pool_in.output.value, r.pool_nft) == 1
  let r_ada_in = assets.lovelace_of(pool_in.output.value)
  let r_tok_in = utils.asset_qty(pool_in.output.value, r.token)

  // pool output: the single tagged output, recreated at the pool's address with
  // the NFT (continuity). v1 full-fill => exactly one tagged output; partial-fill
  // remainders (also tagged) are a later milestone.
  expect [pool_out] = list.filter(
    tx.outputs,
    fn(o) { utils.is_tagged(o, account) },
  )
  expect pool_out.address == pool_in.output.address
  expect utils.asset_qty(pool_out.value, r.pool_nft) == 1
  let r_ada_out = assets.lovelace_of(pool_out.value)
  let r_tok_out = utils.asset_qty(pool_out.value, r.token)

  // (6) O(N) positional binding: owner-outputs are the first N outputs in
  // canonical (input) order. Length guard: every order has a real bound output.
  let n = list.length(order_inputs)
  let owner_outputs = list.take(tx.outputs, n)
  expect list.length(owner_outputs) == n
  let (sum_sold, sum_received, _sum_tip) = process_orders(
    order_inputs,
    owner_outputs,
    r,
  )

  // (1) traded-ADA role: pool gains exactly the sold token, pays exactly the
  // traded ADA — tips/min-ADA never leak into reserves.
  expect r_tok_out == r_tok_in + sum_sold
  expect r_ada_out == r_ada_in - sum_received

  // (1) global conservation: nothing minted/burned; token & ADA in == out.
  expect assets.is_zero(tx.mint)
  let in_ada = list.foldl(
    tx.inputs,
    0,
    fn(i, a) { a + assets.lovelace_of(i.output.value) },
  )
  let out_ada = list.foldl(
    tx.outputs,
    0,
    fn(o, a) { a + assets.lovelace_of(o.value) },
  )
  let in_tok = list.foldl(
    tx.inputs,
    0,
    fn(i, a) { a + utils.asset_qty(i.output.value, r.token) },
  )
  let out_tok = list.foldl(
    tx.outputs,
    0,
    fn(o, a) { a + utils.asset_qty(o.value, r.token) },
  )
  expect in_ada == out_ada
  expect in_tok == out_tok

  // NB: k_after >= k_before is enforced by the POOL validator (§5.4 split).
  True
}
