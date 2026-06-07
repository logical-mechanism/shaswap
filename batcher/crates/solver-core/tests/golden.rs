//! Golden cross-checks: feed the solver-core pin generator the *exact* fixtures
//! from `contracts/lib/shaswap/clearing_test.ak` and assert it produces the *exact*
//! outputs those Aiken tests hard-code as accepted. If this file and the validator
//! ever disagree by a lovelace, a built settlement would be rejected on-chain — so
//! these are the contract's acceptance criteria, restated in Rust.
//!
//! Scenario names match the Aiken `test`s they mirror.

use solver_core::clearing::{build_settlement, ClearingError, Price};
use solver_core::output::{Address, Datum, OrderInput, Output, PoolInput};
use solver_core::types::{
    AssetId, BoundDatum, Credential, OrderDatum, OutputReference, PoolDatum, NFT_NAME,
};
use solver_core::value::Value;

// ---- fixtures (mirror clearing_test.ak constants) ---------------------------

fn s_hash() -> Vec<u8> {
    vec![0x55u8; 28]
}
fn o_hash() -> Vec<u8> {
    vec![0x0bu8; 28]
}
fn p_hash() -> Vec<u8> {
    vec![0x99u8; 28]
}
fn owner_vkh() -> Vec<u8> {
    vec![0xb1u8; 28]
}
fn order_txid() -> Vec<u8> {
    vec![0xa1u8; 32]
}
fn pool_txid() -> Vec<u8> {
    vec![0xd1u8; 32]
}

fn tok() -> AssetId {
    AssetId::new(vec![0x33u8; 28], vec![0x54])
}
fn tokb() -> AssetId {
    AssetId::new(vec![0x88u8; 28], vec![0x42])
}
fn nft() -> AssetId {
    AssetId::new(vec![0x44u8; 28], NFT_NAME.to_vec())
}
fn ada() -> AssetId {
    AssetId::ada()
}
fn owner() -> Credential {
    Credential::VerificationKey(owner_vkh())
}

const SELL: i128 = 1_000_000;
const TIP: i128 = 2_000_000;
const MIN_ADA: i128 = 2_000_000;
const ORDER_IN_ADA: i128 = MIN_ADA + TIP; // 4_000_000
const RECEIVED: i128 = 500_000; // sell * 1/2
const LIMIT: i128 = 400_000;
const OWNER_OUT_ADA: i128 = ORDER_IN_ADA - TIP + RECEIVED; // 2_500_000
const POOL_ADA_IN: i128 = 1_000_000_000_000;
const POOL_TOK_IN: i128 = 1_000_000_000_000;

fn s_cred() -> Credential {
    Credential::Script(s_hash())
}

fn tagged(payment: Credential) -> Address {
    Address {
        payment,
        stake: Some(s_cred()),
    }
}
fn plain(payment: Credential) -> Address {
    Address {
        payment,
        stake: None,
    }
}

fn tok_val(lovelace: i128, t: i128) -> Value {
    Value::from_lovelace(lovelace).add(&tok().policy, &tok().name, t)
}
fn pool_val(lovelace: i128, t: i128) -> Value {
    tok_val(lovelace, t).add(&nft().policy, &nft().name, 1)
}

fn order_ref(i: u64) -> OutputReference {
    OutputReference {
        transaction_id: order_txid(),
        output_index: i,
    }
}

fn order_datum() -> OrderDatum {
    OrderDatum {
        owner: owner(),
        owner_stake: None,
        pool_nft: nft(),
        sell_a: true,
        sell_amount: SELL,
        limit: LIMIT,
        tip: TIP,
        partial: false,
        deadline: None,
    }
}

fn pool_datum() -> PoolDatum {
    PoolDatum {
        nft: nft(),
        asset_a: tok(),
        asset_b: ada(),
        fee_num: 3,
        fee_den: 1000,
        creator: owner(),
    }
}

fn order_input(i: u64) -> OrderInput {
    OrderInput {
        output_reference: order_ref(i),
        address: tagged(Credential::Script(o_hash())),
        value: tok_val(ORDER_IN_ADA, SELL),
        datum: order_datum(),
    }
}

fn pool_input() -> PoolInput {
    PoolInput {
        output_reference: OutputReference {
            transaction_id: pool_txid(),
            output_index: 0,
        },
        address: tagged(Credential::Script(p_hash())),
        value: pool_val(POOL_ADA_IN, POOL_TOK_IN),
        datum: pool_datum(),
    }
}

fn price_1_2() -> Price {
    Price { num: 1, den: 2 }
}

fn owner_payout(value: Value, bind: u64) -> Output {
    Output {
        address: plain(owner()),
        value,
        datum: Datum::Bound(BoundDatum {
            order_ref: order_ref(bind),
        }),
        reference_script: None,
    }
}

// ---- happy path -------------------------------------------------------------

#[test]
fn happy_n1() {
    let st = build_settlement(&[order_input(0)], &[SELL], &pool_input(), price_1_2(), None)
        .expect("n1 should clear");

    assert_eq!(st.owner_outputs.len(), 1);
    assert_eq!(
        st.owner_outputs[0],
        owner_payout(Value::from_lovelace(OWNER_OUT_ADA), 0)
    );
    assert_eq!(
        st.pool_output.value,
        pool_val(POOL_ADA_IN - RECEIVED, POOL_TOK_IN + SELL)
    );
    assert_eq!(st.pool_output.datum, Datum::Pool(pool_datum()));
    assert_eq!((st.net_a, st.net_b), (SELL, -RECEIVED));
    assert_eq!(st.tip_taken_total, TIP);
    assert!(st.remainders.is_empty());
}

#[test]
fn happy_n3_canonical_order() {
    let orders = [order_input(0), order_input(1), order_input(2)];
    let st = build_settlement(
        &orders,
        &[SELL, SELL, SELL],
        &pool_input(),
        price_1_2(),
        None,
    )
    .expect("n3 should clear");
    assert_eq!(st.owner_outputs.len(), 3);
    // each owner output binds to its own order ref, in canonical (index) order.
    for (i, o) in st.owner_outputs.iter().enumerate() {
        assert_eq!(
            o.datum,
            Datum::Bound(BoundDatum {
                order_ref: order_ref(i as u64)
            })
        );
        assert_eq!(o.value, Value::from_lovelace(OWNER_OUT_ADA));
    }
    assert_eq!(
        st.pool_output.value,
        pool_val(POOL_ADA_IN - RECEIVED * 3, POOL_TOK_IN + SELL * 3)
    );
    assert_eq!(st.tip_taken_total, TIP * 3);
}

// ---- partial fill (proportional tip) ----------------------------------------

#[test]
fn partial_token_seller() {
    // mirrors clearing_test::partial_token_seller: fill 400_000 of 1_000_000 at 1/2.
    let order = OrderInput {
        output_reference: order_ref(0),
        address: tagged(Credential::Script(o_hash())),
        value: tok_val(TIP + 2 * MIN_ADA, SELL), // pre-funds two min-ADAs
        datum: OrderDatum {
            partial: true,
            ..order_datum()
        },
    };
    let st = build_settlement(&[order], &[400_000], &pool_input(), price_1_2(), None)
        .expect("partial should clear");

    // owner gets 2_200_000 ADA (keeps one min-ADA + 200_000 received, minus full tip).
    assert_eq!(st.owner_outputs[0].value, Value::from_lovelace(2_200_000));
    // pool absorbs +400_000 tok / -200_000 ADA.
    assert_eq!(
        st.pool_output.value,
        pool_val(POOL_ADA_IN - 200_000, POOL_TOK_IN + 400_000)
    );
    // remainder: 600_000 tok + (min 2_000_000 + leftover tip 1_200_000) = 3_200_000 ADA,
    // datum partial=false, sell 600_000, limit 240_000, tip 1_200_000, at order addr.
    assert_eq!(st.remainders.len(), 1);
    let rem = &st.remainders[0];
    assert_eq!(rem.value, tok_val(3_200_000, 600_000));
    assert_eq!(rem.address, tagged(Credential::Script(o_hash())));
    assert_eq!(
        rem.datum,
        Datum::Order(OrderDatum {
            owner: owner(),
            owner_stake: None,
            pool_nft: nft(),
            sell_a: true,
            sell_amount: 600_000,
            limit: 240_000,
            tip: 1_200_000,
            partial: false,
            deadline: None,
        })
    );
    // solver collects the proportional tip only: 2_000_000 * 400_000 / 1_000_000.
    assert_eq!(st.tip_taken_total, 800_000);
}

// ---- H-01 (audit 060426): a partial-fill remainder must consent to the SAME pool
// it came from. `clearing.ak::consume_remainder` now requires
// `ro.pool_nft == order.pool_nft`, so the rolled-over `OrderDatum.pool_nft` the
// solver writes MUST equal the consumed order's `pool_nft` — else every partial-fill
// settlement the batcher builds is rejected on-chain. This pins that invariant.
#[test]
fn remainder_pool_nft_pinned_to_consumed_order() {
    let order = OrderInput {
        output_reference: order_ref(0),
        address: tagged(Credential::Script(o_hash())),
        value: tok_val(TIP + 2 * MIN_ADA, SELL),
        datum: OrderDatum {
            partial: true,
            ..order_datum()
        },
    };
    let st = build_settlement(
        std::slice::from_ref(&order),
        &[400_000],
        &pool_input(),
        price_1_2(),
        None,
    )
    .expect("partial should clear");
    assert_eq!(st.remainders.len(), 1);
    let Datum::Order(rem) = &st.remainders[0].datum else {
        panic!("remainder must carry an OrderDatum");
    };
    // The H-01 invariant: the remainder consents to the same pool as its source order
    // (which the anchor also asserts equals the settled pool's NFT).
    assert_eq!(rem.pool_nft, order.datum.pool_nft);
    assert_eq!(rem.pool_nft, pool_input().datum.nft);
}

// ---- bidirectional netting --------------------------------------------------

fn ada_order_input(i: u64, sell_ada: i128, limit: i128) -> OrderInput {
    OrderInput {
        output_reference: order_ref(i),
        address: tagged(Credential::Script(o_hash())),
        value: Value::from_lovelace(sell_ada + TIP + MIN_ADA),
        datum: OrderDatum {
            owner: owner(),
            owner_stake: None,
            pool_nft: nft(),
            sell_a: false,
            sell_amount: sell_ada,
            limit,
            tip: TIP,
            partial: false,
            deadline: None,
        },
    }
}

#[test]
fn netting_perfect_leaves_pool_untouched() {
    // token-seller 1_000_000 tok -> 500_000 ADA; ADA-seller 500_000 -> 1_000_000 tok.
    let orders = [order_input(0), ada_order_input(1, 500_000, 1_000_000)];
    let st = build_settlement(&orders, &[SELL, 500_000], &pool_input(), price_1_2(), None)
        .expect("perfect netting should clear");
    // pool is untouched: net == 0, value identical to input.
    assert_eq!((st.net_a, st.net_b), (0, 0));
    assert_eq!(st.pool_output.value, pool_val(POOL_ADA_IN, POOL_TOK_IN));
    // ADA-seller owner output: 1_000_000 tok + its min-ADA back.
    assert_eq!(
        st.owner_outputs[1].value,
        Value::from_lovelace(MIN_ADA).add(&tok().policy, &tok().name, 1_000_000)
    );
    assert_eq!(st.tip_taken_total, TIP * 2);
}

#[test]
fn ada_seller_solo() {
    let orders = [ada_order_input(0, 500_000, 1_000_000)];
    let st = build_settlement(&orders, &[500_000], &pool_input(), price_1_2(), None)
        .expect("ada seller should clear");
    // pool +500_000 ADA, -1_000_000 tok.
    assert_eq!(
        st.pool_output.value,
        pool_val(POOL_ADA_IN + 500_000, POOL_TOK_IN - 1_000_000)
    );
    assert_eq!((st.net_a, st.net_b), (-1_000_000, 500_000));
}

// ---- token/token pair -------------------------------------------------------

#[test]
fn token_token() {
    // asset_a = tok, asset_b = tokb; price 3 tokb per tok; sell 1000 tok -> 3000 tokb.
    let pool = PoolInput {
        output_reference: OutputReference {
            transaction_id: pool_txid(),
            output_index: 0,
        },
        address: tagged(Credential::Script(p_hash())),
        value: Value::from_lovelace(2_000_000)
            .add(&tok().policy, &tok().name, 1_000_000)
            .add(&tokb().policy, &tokb().name, 3_000_000)
            .add(&nft().policy, &nft().name, 1),
        datum: PoolDatum {
            asset_b: tokb(),
            ..pool_datum()
        },
    };
    let order = OrderInput {
        output_reference: order_ref(0),
        address: tagged(Credential::Script(o_hash())),
        value: Value::from_lovelace(TIP + MIN_ADA).add(&tok().policy, &tok().name, 1000),
        datum: OrderDatum {
            sell_amount: 1000,
            limit: 2000,
            ..order_datum()
        },
    };
    let st = build_settlement(&[order], &[1000], &pool, Price { num: 3, den: 1 }, None)
        .expect("token/token should clear");
    // owner: 3000 tokb + min-ADA (lovelace is pure overhead here).
    assert_eq!(
        st.owner_outputs[0].value,
        Value::from_lovelace(MIN_ADA).add(&tokb().policy, &tokb().name, 3000)
    );
    // pool: +1000 tok, -3000 tokb; lovelace + NFT preserved exactly.
    assert_eq!(
        st.pool_output.value,
        Value::from_lovelace(2_000_000)
            .add(&tok().policy, &tok().name, 1_000_000 + 1000)
            .add(&tokb().policy, &tokb().name, 3_000_000 - 3000)
            .add(&nft().policy, &nft().name, 1)
    );
}

// ---- incidental asset passes through to the owner ---------------------------

#[test]
fn incidental_asset_returns_to_owner() {
    let junk = AssetId::new(vec![0x77u8; 28], b"jnk".to_vec());
    let order = OrderInput {
        value: tok_val(ORDER_IN_ADA, SELL).add(&junk.policy, &junk.name, 5),
        ..order_input(0)
    };
    let st = build_settlement(&[order], &[SELL], &pool_input(), price_1_2(), None).unwrap();
    // the 5 junk tokens ride through to the owner, never the solver.
    assert_eq!(
        st.owner_outputs[0].value,
        Value::from_lovelace(OWNER_OUT_ADA).add(&junk.policy, &junk.name, 5)
    );
}

// ---- rejection paths (mirror the Aiken `fail` tests) ------------------------

#[test]
fn floor_breach_rejected() {
    // limit > what the price yields: received(500_000) but limit 500_001.
    let order = OrderInput {
        datum: OrderDatum {
            limit: RECEIVED + 1,
            ..order_datum()
        },
        ..order_input(0)
    };
    assert_eq!(
        build_settlement(&[order], &[SELL], &pool_input(), price_1_2(), None),
        Err(ClearingError::FloorBreach { index: 0 })
    );
}

#[test]
fn partial_not_allowed_rejected() {
    // partial fill of an order with partial == false.
    assert_eq!(
        build_settlement(
            &[order_input(0)],
            &[400_000],
            &pool_input(),
            price_1_2(),
            None
        ),
        Err(ClearingError::PartialNotAllowed { index: 0 })
    );
}

#[test]
fn order_wrong_pool_rejected() {
    let other = AssetId::new(vec![0x12u8; 28], NFT_NAME.to_vec());
    let order = OrderInput {
        datum: OrderDatum {
            pool_nft: other,
            ..order_datum()
        },
        ..order_input(0)
    };
    assert_eq!(
        build_settlement(&[order], &[SELL], &pool_input(), price_1_2(), None),
        Err(ClearingError::OrderWrongPool { index: 0 })
    );
}

#[test]
fn deadline_expired_rejected() {
    // deadline 1000, but tx upper bound 1500 (could be included after): rejected.
    let order = OrderInput {
        datum: OrderDatum {
            deadline: Some(1000),
            ..order_datum()
        },
        ..order_input(0)
    };
    assert_eq!(
        build_settlement(&[order], &[SELL], &pool_input(), price_1_2(), Some(1500)),
        Err(ClearingError::DeadlineUnhonorable { index: 0 })
    );
}

#[test]
fn deadline_within_ok() {
    let order = OrderInput {
        datum: OrderDatum {
            deadline: Some(1000),
            ..order_datum()
        },
        ..order_input(0)
    };
    assert!(build_settlement(&[order], &[SELL], &pool_input(), price_1_2(), Some(900)).is_ok());
}

#[test]
fn nonpositive_price_rejected() {
    assert_eq!(
        build_settlement(
            &[order_input(0)],
            &[SELL],
            &pool_input(),
            Price { num: 0, den: 2 },
            None
        ),
        Err(ClearingError::NonPositivePrice)
    );
    assert_eq!(
        build_settlement(
            &[order_input(0)],
            &[SELL],
            &pool_input(),
            Price { num: 1, den: 0 },
            None
        ),
        Err(ClearingError::NonPositivePrice)
    );
}

#[test]
fn fills_length_mismatch_rejected() {
    assert_eq!(
        build_settlement(
            &[order_input(0)],
            &[SELL, SELL],
            &pool_input(),
            price_1_2(),
            None
        ),
        Err(ClearingError::FillsLengthMismatch)
    );
}
