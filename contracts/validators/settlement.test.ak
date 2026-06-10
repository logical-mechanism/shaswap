//// Validator-entrypoint tests for the settlement trust anchor (audit I-06).
//// These drive the real `settlement.publish` handler through the validator wrapper
//// (not just the `clearing.allow_registration` lib function it delegates to), so the
//// dispatch wiring of the immortal withdraw-0 anchor's certificate authority is
//// actually exercised under a constructed context — the gap the audit flagged
//// ("redeemer dispatch never driven through a validator").

use aiken/fuzz
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{
  AlwaysAbstain, Certificate, DelegateCredential, DelegateVote,
  RegisterCredential, UnregisterCredential,
}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use settlement
use shaswap/types.{AssetId, PoolDatum, SettlementRedeemer}

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const p_hash = #"9999999999999999999999999999999999999999999999999999999c"

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

const ada = AssetId { policy: #"", name: #"" }

const nft =
  AssetId {
    policy: #"4444444444444444444444444444444444444444444444444444444e",
    name: #"4e4654",
  }

fn s() -> Credential {
  Script(s_hash)
}

// `publish` ACCEPTS registration of S — the only path that brings the anchor into
// existence (so the withdraw-0 trick can ever validate).
test settlement_publish_accepts_register() {
  settlement.settlement.publish(
    0,
    RegisterCredential { credential: s(), deposit: Never },
    transaction.placeholder,
  )
}

// `publish` REJECTS de-registration: a griefer must never un-register S and brick
// every settlement forever.
test settlement_publish_rejects_unregister() fail {
  settlement.settlement.publish(
    0,
    UnregisterCredential { credential: s(), refund: Never },
    transaction.placeholder,
  )
}

// `publish` REJECTS delegation: S stays undelegatable, so its always-zero rewards
// can never be captured.
test settlement_publish_rejects_delegate() fail {
  settlement.settlement.publish(
    0,
    DelegateCredential {
      credential: s(),
      delegate: DelegateVote { delegate_representative: AlwaysAbstain },
    },
    transaction.placeholder,
  )
}

// ---- withdraw (clearing.run) through the wrapper -------------------------------------
// (audit I-01, Fable5) the anchor's `withdraw` handler — its main settlement entrypoint —
// was only driven at the `clearing.run` lib layer. Drive it through the validator's own
// `withdraw` signature with an N=0 (pool-only) settlement: the pool is pinned EXACTLY
// (same address/value/datum, NFT preserved), zero orders, `mint == 0` ⇒ passes.

fn pool_addr() -> Address {
  Address {
    payment_credential: Script(p_hash),
    stake_credential: Some(Inline(s())),
  }
}

fn pool_datum() -> PoolDatum {
  PoolDatum {
    nft,
    asset_a: tok,
    asset_b: ada,
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(
      #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    ),
  }
}

fn pool_value() {
  assets.from_lovelace(100_000_000)
    |> assets.add(tok.policy, tok.name, 200_000_000)
    |> assets.add(nft.policy, nft.name, 1)
}

fn pool_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    output_index: 0,
  }
}

fn n0_redeemer() -> SettlementRedeemer {
  SettlementRedeemer {
    price_num: 1,
    price_den: 1,
    asset_a: tok,
    asset_b: ada,
    pool_nft: nft,
    fills: [],
  }
}

fn n0_tx() -> Transaction {
  let pool_in = Input {
    output_reference: pool_ref(),
    output: Output {
      address: pool_addr(),
      value: pool_value(),
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
  let pool_out = Output {
    address: pool_addr(),
    value: pool_value(),
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_in],
    outputs: [pool_out],
    withdrawals: [Pair(s(), 0)],
  }
}

test settlement_withdraw_n0_via_wrapper_ok() {
  settlement.settlement.withdraw(n0_redeemer(), s(), n0_tx())
}

// ---- wrapper-inclusive benches (audit O-01, Fable5) ---------------------------------
// The 13 lib benches measure `clearing.run`/`allow_registration` directly; these drive
// the validator's own `withdraw`/`publish` entrypoints so the wrapper dispatch is part
// of the ex-unit figure (an accurate per-tx budget for the batch-size ceiling).

fn register_cert_sampler(_n: Int) -> Fuzzer<Certificate> {
  fuzz.constant(RegisterCredential { credential: s(), deposit: Never })
}

bench settlement__publish(c via register_cert_sampler) {
  settlement.settlement.publish(0, c, transaction.placeholder)
}

fn n0_tx_sampler(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(n0_tx())
}

bench settlement__withdraw__wrapper(tx via n0_tx_sampler) {
  settlement.settlement.withdraw(n0_redeemer(), s(), tx)
}
