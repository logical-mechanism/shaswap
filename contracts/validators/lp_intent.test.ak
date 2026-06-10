//// Validator-entrypoint tests for the lp_intent validator (audit I-01, Fable5). These
//// drive the real `lp_intent.spend` wrapper — the `expect Some(d) = datum` no-datum
//// abort and the `Fulfill`/`ReclaimLp` dispatch — under a constructed `Transaction`. The
//// deposit/withdraw math is covered at the lib layer in `lp_intent_test.ak`; this closes
//// the wrapper-dispatch gap. `Fulfill`'s FIRST check is `!withdrawal_present(S)` (the
//// no-settlement-fold guard); `ReclaimLp` is owner-VK-signature only.

use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use lp_intent
use shaswap/lp_intent_types.{Fulfill, LpDeposit, LpIntentDatum, ReclaimLp}
use shaswap/types.{AssetId}

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const lp_intent_hash =
  #"1111111111111111111111111111111111111111111111111111111e"

const owner_vkh = #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

const nft =
  AssetId {
    policy: #"4444444444444444444444444444444444444444444444444444444e",
    name: #"4e4654",
  }

fn s() -> Credential {
  Script(s_hash)
}

fn intent_datum() -> LpIntentDatum {
  LpIntentDatum {
    owner: VerificationKey(owner_vkh),
    owner_stake: None,
    pool_nft: nft,
    action: LpDeposit,
    min_a: 0,
    min_b: 0,
    min_shares: 0,
    tip: 0,
    deadline: None,
  }
}

fn intent_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
    output_index: 0,
  }
}

// an LP-intent UTXO at the lp_intent validator's ENTERPRISE address (stake = None, never
// S-tagged — the anchor must not enumerate it).
fn intent_in() -> Input {
  Input {
    output_reference: intent_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(lp_intent_hash),
        stake_credential: None,
      },
      value: assets.from_lovelace(4_000_000),
      datum: InlineDatum(intent_datum()),
      reference_script: None,
    },
  }
}

// (audit I-01) Fulfill arm via the wrapper: a fulfillment with the settlement withdraw-0
// for S PRESENT is rejected — `fulfill` asserts `!withdrawal_present(S)` first, so an LP
// fulfillment can never be folded into a settlement (which would dodge the per-share
// backing). This guard's wrapper dispatch was never executed under a context before.
test lp_intent_fulfill_via_wrapper_blocked_by_settlement() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [intent_in()],
    withdrawals: [Pair(s(), 0)],
  }
  lp_intent.lp_intent.spend(
    s(),
    Some(intent_datum()),
    Fulfill,
    intent_ref(),
    tx,
  )
}

// (audit I-01) ReclaimLp arm via the wrapper: the owner's VK signature alone authorizes
// the non-custodial exit.
test lp_intent_reclaim_via_wrapper_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    extra_signatories: [owner_vkh],
  }
  lp_intent.lp_intent.spend(
    s(),
    Some(intent_datum()),
    ReclaimLp,
    intent_ref(),
    tx,
  )
}

// ReclaimLp without the owner's signature: rejected.
test lp_intent_reclaim_via_wrapper_no_sig() fail {
  lp_intent.lp_intent.spend(
    s(),
    Some(intent_datum()),
    ReclaimLp,
    intent_ref(),
    transaction.placeholder,
  )
}

// no datum on the intent UTXO: `expect Some(d) = datum` aborts (phase-2 failure).
test lp_intent_spend_no_datum() fail {
  lp_intent.lp_intent.spend(
    s(),
    None,
    ReclaimLp,
    intent_ref(),
    transaction.placeholder,
  )
}
