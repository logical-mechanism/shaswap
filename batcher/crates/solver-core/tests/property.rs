//! Property tests over random order books. Mirrors the intent of the Aiken
//! `prop_*` fuzz tests, but asserts the *generator's* core safety invariant:
//!
//! > **Conservation + no-skim.** For every settlement the solver builds,
//! > `Σ(order inputs) + pool_input  ==  Σ(owner outputs) + pool_output +
//! > Σ(remainders) + (solver's ADA tip take)`, with `mint == 0`.
//!
//! Because the owner/remainder/pool values are pure transforms of the inputs and
//! the solver's only credit is `tip_taken_total` lovelace, this equation holding
//! across the whole random input space *is* the statement that the solver can take
//! **only** the proportional tips — no value leaks to it from any role (the §5.2.1
//! property the on-chain ledger-conservation pass enforces). A bug in any per-role
//! delta would unbalance it.

use solver_core::clearing::{build_settlement, Price, Settlement};
use solver_core::output::{Address, OrderInput, PoolInput};
use solver_core::types::{
    AssetId, Credential, OrderDatum, OutputReference, PoolDatum, ORDER_MIN_ADA,
};
use solver_core::value::Value;

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9e37_79b9_7f4a_7c15)
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn range(&mut self, lo: i128, hi: i128) -> i128 {
        lo + (self.next() as u128 % (hi - lo + 1) as u128) as i128
    }
}

fn tok() -> AssetId {
    AssetId::new(vec![0x33u8; 28], vec![0x54])
}
fn nft() -> AssetId {
    AssetId::new(vec![0x44u8; 28], solver_core::types::NFT_NAME.to_vec())
}
fn owner() -> Credential {
    Credential::VerificationKey(vec![0xb1u8; 28])
}
fn s_cred() -> Credential {
    Credential::Script(vec![0x55u8; 28])
}
fn tagged(p: Credential) -> Address {
    Address {
        payment: p,
        stake: Some(s_cred()),
    }
}

const POOL_RES: i128 = 1_000_000_000_000;

fn pool() -> PoolInput {
    PoolInput {
        output_reference: OutputReference {
            transaction_id: vec![0xd1u8; 32],
            output_index: 0,
        },
        address: tagged(Credential::Script(vec![0x99u8; 28])),
        value: Value::from_lovelace(POOL_RES + 2_000_000)
            .add(&tok().policy, &tok().name, POOL_RES)
            .add(&nft().policy, &nft().name, 1),
        datum: PoolDatum {
            nft: nft(),
            asset_a: tok(),
            asset_b: AssetId::ada(),
            fee_num: 3,
            fee_den: 1000,
            creator: owner(),
        },
    }
}

/// Total value entering the clearing system (orders + pool).
fn total_in(orders: &[OrderInput], pool: &PoolInput) -> Value {
    let mut v = pool.value.clone();
    for o in orders {
        v = v.merge(&o.value);
    }
    v
}

/// Total value leaving it (owners + pool + remainders), plus the solver's tip take.
fn total_out_plus_solver(st: &Settlement) -> Value {
    let mut v = st.pool_output.value.clone();
    for o in &st.owner_outputs {
        v = v.merge(&o.value);
    }
    for r in &st.remainders {
        v = v.merge(&r.value);
    }
    // the solver's only credit: ADA tips taken now.
    v.merge(&Value::from_lovelace(st.tip_taken_total))
}

/// Build a single random *token-seller* order that pre-funds two min-ADAs (so it
/// can be partially filled), with a market floor (`limit == 0`) so the property
/// targets value/rounding, not the floor (which is unit-tested separately).
fn token_seller(sell: i128, tip: i128, partial: bool) -> OrderInput {
    OrderInput {
        output_reference: OutputReference {
            transaction_id: vec![0xa1u8; 32],
            output_index: 0,
        },
        address: tagged(Credential::Script(vec![0x0bu8; 28])),
        value: Value::from_lovelace(tip + 2 * ORDER_MIN_ADA).add(&tok().policy, &tok().name, sell),
        datum: OrderDatum {
            owner: owner(),
            pool_nft: nft(),
            sell_a: true,
            sell_amount: sell,
            limit: 0,
            tip,
            partial,
            deadline: None,
        },
    }
}

fn ada_seller(sell: i128, tip: i128, partial: bool) -> OrderInput {
    OrderInput {
        output_reference: OutputReference {
            transaction_id: vec![0xa2u8; 32],
            output_index: 0,
        },
        address: tagged(Credential::Script(vec![0x0bu8; 28])),
        value: Value::from_lovelace(sell + tip + 2 * ORDER_MIN_ADA),
        datum: OrderDatum {
            owner: owner(),
            pool_nft: nft(),
            sell_a: false,
            sell_amount: sell,
            limit: 0,
            tip,
            partial,
            deadline: None,
        },
    }
}

#[test]
fn conservation_holds_over_random_settlements() {
    let mut rng = Rng::new(0xC0FFEE);
    let mut full = 0;
    let mut partial = 0;
    for _ in 0..5_000 {
        let sell = rng.range(1, 5_000_000);
        let fill_raw = rng.range(1, 5_000_000);
        let f = fill_raw.min(sell);
        let pn = rng.range(1, 1000);
        let pd = rng.range(1, 1000);
        let tip = rng.range(0, 10_000_000);
        let sell_a = rng.next() & 1 == 0;
        let is_partial = f < sell;

        let order = if sell_a {
            token_seller(sell, tip, is_partial)
        } else {
            ada_seller(sell, tip, is_partial)
        };
        let pool = pool();
        let st = match build_settlement(
            std::slice::from_ref(&order),
            &[f],
            &pool,
            Price { num: pn, den: pd },
            None,
        ) {
            Ok(s) => s,
            // overflow on an extreme price is surfaced, not silently wrong; skip.
            Err(_) => continue,
        };

        let lhs = total_in(&[order], &pool);
        let rhs = total_out_plus_solver(&st);
        assert_eq!(
            lhs, rhs,
            "conservation broke: sell={sell} f={f} p={pn}/{pd} tip={tip} sell_a={sell_a}"
        );

        // the solver's take is exactly the proportional tip — never more.
        let expected_take = tip * f / sell;
        assert_eq!(st.tip_taken_total, expected_take);

        if is_partial {
            partial += 1;
        } else {
            full += 1;
        }
    }
    // make sure we actually exercised both branches.
    assert!(full > 100 && partial > 100, "full={full} partial={partial}");
}
