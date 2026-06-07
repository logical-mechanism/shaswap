//// Validator-entrypoint tests for the pool validator (audit I-06). These drive the
//// real `pool.spend` wrapper — exercising the `LpAction -> !withdrawal_present(S)`
//// mutual-exclusion guard (which lives ONLY in the wrapper, never in `spend.ak`) and
//// the `expect Some(d) = datum` no-datum path. The value/curve logic itself is
//// covered at the lib layer in `lp_test.ak`; this closes the structural gap the audit
//// flagged (the wrapper guard + dispatch were never executed under a context).

use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use pool
use shaswap/constants.{lp_name, pool_min_ada, total_lp}
use shaswap/types.{AssetId, LpAction, PoolDatum}

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const p_hash = #"9999999999999999999999999999999999999999999999999999999c"

const nft_policy = #"4444444444444444444444444444444444444444444444444444444e"

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

const nft = AssetId { policy: nft_policy, name: #"4e4654" }

const creator_vkh = #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

fn s() -> Credential {
  Script(s_hash)
}

fn pool_datum() -> PoolDatum {
  PoolDatum {
    nft,
    asset_a: tok,
    asset_b: AssetId { policy: #"", name: #"" },
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(creator_vkh),
  }
}

fn pool_addr() -> Address {
  Address {
    payment_credential: Script(p_hash),
    stake_credential: Some(Inline(s())),
  }
}

// a pool value with the per-UTXO min-ADA overhead + reserves + NFT + held LP.
fn pool_value(held: Int) {
  assets.from_lovelace(100_000_000 + pool_min_ada)
    |> assets.add(tok.policy, tok.name, 200_000_000)
    |> assets.add(nft.policy, nft.name, 1)
    |> assets.add(nft.policy, lp_name, held)
}

fn pool_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    output_index: 0,
  }
}

fn pool_in() -> Input {
  Input {
    output_reference: pool_ref(),
    output: Output {
      address: pool_addr(),
      value: pool_value(total_lp - 1_000_000),
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
}

// a no-op LpAction output (reserves/held/NFT/datum all unchanged) — passes
// `spend.lp_action` (incl. the new full-value pin: all deltas zero ⇒ out == in).
fn pool_out_noop() -> Output {
  Output {
    address: pool_addr(),
    value: pool_value(total_lp - 1_000_000),
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

fn noop_tx(withdrawals: Pairs<Credential, Int>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_in()],
    outputs: [pool_out_noop()],
    withdrawals,
  }
}

// LpAction with NO settlement withdraw-0 for S present: the mutual-exclusion guard
// passes, and the no-op LP action validates. (Drives the wrapper dispatch + guard.)
test pool_lpaction_standalone_ok() {
  pool.pool.spend(s(), Some(pool_datum()), LpAction, pool_ref(), noop_tx([]))
}

// LpAction WHILE a settlement withdraw-0 for S is present: the `!withdrawal_present(S)`
// wrapper guard rejects it, so an LP action can never be folded into a settlement
// (which would let it dodge the batch rules / mint unbacked shares). This guard lives
// only in the validator wrapper — covered here for the first time.
test pool_lpaction_blocked_by_settlement() fail {
  pool.pool.spend(
    s(),
    Some(pool_datum()),
    LpAction,
    pool_ref(),
    noop_tx([Pair(s(), 0)]),
  )
}

// no datum on the pool UTXO: `expect Some(d) = datum` aborts (phase-2 failure).
test pool_spend_no_datum() fail {
  pool.pool.spend(s(), None, LpAction, pool_ref(), noop_tx([]))
}
