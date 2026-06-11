//// Validator-entrypoint tests for the order validator (audit I-01, Fable5). These
//// drive the real `order.spend` wrapper — the `expect Some(d) = datum` no-datum abort
//// and the `Settle`/`Reclaim` redeemer dispatch — under a constructed `Transaction`.
//// The settle/reclaim logic itself is covered at the lib layer in `clearing_test.ak`;
//// this closes the structural gap (the wrapper dispatch was never executed under a
//// context). `order_settle` self-checks the input's S tag + the withdraw-0; `Reclaim`
//// is owner-VK-signature only.

use aiken/fuzz
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use order
use shaswap/types.{AssetId, OrderDatum, Reclaim, Settle}

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const o_hash = #"0000000000000000000000000000000000000000000000000000000b"

const owner_vkh = #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

const nft =
  AssetId {
    policy: #"4444444444444444444444444444444444444444444444444444444e",
    name: #"4e4654",
  }

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

fn s() -> Credential {
  Script(s_hash)
}

fn order_datum() -> OrderDatum {
  OrderDatum {
    owner: VerificationKey(owner_vkh),
    owner_stake: None,
    pool_nft: nft,
    sell_a: True,
    sell_amount: 1_000_000,
    limit: 1,
    tip: 0,
    partial: False,
    deadline: None,
  }
}

fn order_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    output_index: 0,
  }
}

// an order UTXO at the order script address, tagged with the settlement credential S.
fn order_in() -> Input {
  Input {
    output_reference: order_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(o_hash),
        stake_credential: Some(Inline(s())),
      },
      value: assets.from_lovelace(4_000_000)
        |> assets.add(tok.policy, tok.name, 1_000_000),
      datum: InlineDatum(order_datum()),
      reference_script: None,
    },
  }
}

fn settle_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [order_in()],
    withdrawals: [Pair(s(), 0)],
  }
}

fn reclaim_tx() -> Transaction {
  Transaction { ..transaction.placeholder, extra_signatories: [owner_vkh] }
}

// (audit I-01) Settle arm via the wrapper: an S-tagged order input + the withdraw-0 for
// S present ⇒ `order_settle` passes (it self-tags + requires the anchor's withdraw-0).
test order_settle_via_wrapper_ok() {
  order.order.spend(s(), Some(order_datum()), Settle, order_ref(), settle_tx())
}

// Settle without the withdraw-0 for S: rejected. Distinguishes the `Settle` arm (needs
// the withdraw-0) from `Reclaim` (needs only a signature) — a swapped dispatch is caught.
test order_settle_via_wrapper_no_withdrawal() fail {
  let tx = Transaction { ..transaction.placeholder, inputs: [order_in()] }
  order.order.spend(s(), Some(order_datum()), Settle, order_ref(), tx)
}

// (audit I-01) Reclaim arm via the wrapper: the owner's VK signature alone authorizes it.
test order_reclaim_via_wrapper_ok() {
  order.order.spend(
    s(),
    Some(order_datum()),
    Reclaim,
    order_ref(),
    reclaim_tx(),
  )
}

// Reclaim without the owner's signature: rejected.
test order_reclaim_via_wrapper_no_sig() fail {
  order.order.spend(
    s(),
    Some(order_datum()),
    Reclaim,
    order_ref(),
    transaction.placeholder,
  )
}

// no datum on the order UTXO: `expect Some(d) = datum` aborts (phase-2 failure).
test order_spend_no_datum() fail {
  order.order.spend(s(), None, Reclaim, order_ref(), transaction.placeholder)
}

// (audit O-01, Fable5) wrapper-inclusive benches: the per-order `order.spend` dispatch
// the batch-size ceiling must budget for (one per settled order), measured through the
// validator entrypoint rather than the `spend.order_*` lib functions alone.
fn settle_tx_sampler(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(settle_tx())
}

bench order__spend__settle(tx via settle_tx_sampler) {
  order.order.spend(s(), Some(order_datum()), Settle, order_ref(), tx)
}

fn reclaim_tx_sampler(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(reclaim_tx())
}

bench order__spend__reclaim(tx via reclaim_tx_sampler) {
  order.order.spend(s(), Some(order_datum()), Reclaim, order_ref(), tx)
}
