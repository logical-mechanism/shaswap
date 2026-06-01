//! Proof that the ShaSwap fork actually builds a withdraw-0 settlement: the body
//! carries the withdrawal and the witness set carries a `Reward` redeemer at the
//! right index. This is precisely what upstream pallas-txbuilder 1.0 cannot do
//! (it hard-codes `withdrawals: None` and has no `Reward` redeemer purpose).

use pallas_addresses::{
    Address, Network, ShelleyAddress, ShelleyDelegationPart, ShelleyPaymentPart,
};
use pallas_crypto::hash::Hash;
use pallas_primitives::conway::{RedeemerTag, Redeemers, Tx};
use shaswap_txbuilder::{BuildConway, ExUnits, Input, Output, StagingTransaction};

fn enterprise_addr() -> Address {
    Address::Shelley(ShelleyAddress::new(
        Network::Testnet,
        ShelleyPaymentPart::Key(Hash::from([0u8; 28])),
        ShelleyDelegationPart::Null,
    ))
}

#[test]
fn builds_withdraw_zero_with_reward_redeemer() {
    // A 29-byte stake (reward) address: header + 28-byte script credential.
    let mut account = vec![0xf0u8];
    account.extend_from_slice(&[0x55u8; 28]);
    // The settlement redeemer data — any valid Plutus Data; Constr 0 [] = 0xd87980.
    let redeemer_data = vec![0xd8u8, 0x79, 0x80];

    let built = StagingTransaction::new()
        .input(Input::new(Hash::from([0xa1u8; 32]), 0))
        .output(Output::new(enterprise_addr(), 2_000_000))
        .fee(200_000)
        // withdraw-0 from S + the reward redeemer that authorizes it.
        .withdrawal(account.clone(), 0)
        .add_withdraw_redeemer(
            account.clone(),
            redeemer_data,
            Some(ExUnits {
                mem: 1_000_000,
                steps: 500_000_000,
            }),
        )
        .build_conway_raw()
        .expect("withdraw-0 tx should build");

    // Re-decode the built CBOR with stock pallas-primitives and inspect it.
    let tx: Tx = pallas_codec::minicbor::decode(&built.tx_bytes.0).expect("valid conway tx cbor");

    // 1) the body carries exactly our withdrawal, amount 0.
    let withdrawals = tx
        .transaction_body
        .withdrawals
        .clone()
        .expect("withdrawals must be present (the upstream TODO this fork fixes)");
    assert_eq!(withdrawals.len(), 1);
    let (acct, coin) = withdrawals.iter().next().unwrap();
    assert_eq!(acct.as_ref() as &[u8], account.as_slice());
    assert_eq!(*coin, 0);

    // 2) the witness set carries a Reward redeemer at index 0 (the lone withdrawal).
    let rdmrs = tx
        .transaction_witness_set
        .redeemer
        .as_ref()
        .expect("a reward redeemer must be present");
    match &**rdmrs {
        Redeemers::List(v) => {
            assert_eq!(v.len(), 1);
            assert_eq!(v[0].tag, RedeemerTag::Reward);
            assert_eq!(v[0].index, 0);
            assert_eq!(v[0].ex_units.mem, 1_000_000);
        }
        Redeemers::Map(m) => {
            assert_eq!(m.len(), 1);
            let (k, _) = m.iter().next().unwrap();
            assert_eq!(k.tag, RedeemerTag::Reward);
            assert_eq!(k.index, 0);
        }
    }
}

#[test]
fn is_valid_is_always_true() {
    // ShaSwap invariant (relied on by the batcher): every built tx has
    // `isValid == true`. A `false` would tell the ledger "my scripts fail, take my
    // collateral" — the solver must never emit one. There is no builder API to set
    // it false, so this is by construction; the test pins it against regressions.
    let built = StagingTransaction::new()
        .input(Input::new(Hash::from([0xa1u8; 32]), 0))
        .output(Output::new(enterprise_addr(), 2_000_000))
        .fee(200_000)
        .build_conway_raw()
        .expect("tx should build");
    let tx: Tx = pallas_codec::minicbor::decode(&built.tx_bytes.0).expect("valid conway tx cbor");
    assert!(
        tx.success,
        "isValid must always be true (never burn collateral)"
    );
}

#[test]
fn reward_redeemer_without_matching_withdrawal_is_rejected() {
    // A reward redeemer whose account isn't in the withdrawals set has no index to
    // bind to — the build must fail rather than emit a dangling redeemer.
    let account = vec![0x55u8; 29];
    let other = vec![0x66u8; 29];
    let err = StagingTransaction::new()
        .input(Input::new(Hash::from([0xa1u8; 32]), 0))
        .output(Output::new(enterprise_addr(), 2_000_000))
        .fee(200_000)
        .withdrawal(account, 0)
        .add_withdraw_redeemer(
            other,
            vec![0xd8, 0x79, 0x80],
            Some(ExUnits { mem: 1, steps: 1 }),
        )
        .build_conway_raw();
    assert!(err.is_err(), "dangling reward redeemer must be rejected");
}
