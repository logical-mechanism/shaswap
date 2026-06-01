//! Live integration smoke tests against a running Kupo (:1442) + Ogmios (:1337)
//! over the local preprod node. `#[ignore]` so `cargo test` stays offline; run
//! explicitly once the services are up:
//!
//! ```sh
//! SHASWAP_DEPLOYMENT=../../contracts/happy_path/deployment.json \
//!   cargo test -p chain --test live -- --ignored --nocapture
//! ```

use chain::backend::ChainBackend;
use chain::config::Config;
use chain::kupo_ogmios::KupoOgmios;

fn backend() -> KupoOgmios {
    let path = std::env::var("SHASWAP_DEPLOYMENT")
        .unwrap_or_else(|_| "../../contracts/happy_path/deployment.json".to_string());
    let json = std::fs::read_to_string(&path).expect("read deployment.json");
    let cfg = Config::from_json(&json).expect("valid config");
    KupoOgmios::new(cfg).expect("backend")
}

#[test]
#[ignore]
fn live_tip_and_params() {
    let b = backend();
    let tip = b.tip().expect("tip");
    println!("tip slot = {}", tip.slot);
    assert!(tip.slot > 100_000_000);

    let p = b.protocol_params().expect("params");
    println!(
        "min_fee_a={} min_fee_b={} price_mem={:?} cost_model_v3.len={}",
        p.min_fee_a,
        p.min_fee_b,
        p.price_mem,
        p.cost_model_v3.len()
    );
    assert_eq!(p.cost_model_v3.len(), 350);
}

#[test]
#[ignore]
fn live_find_pool() {
    let b = backend();
    let nft = b.config().pool_nft.clone();
    let pool = b.find_pool(&nft).expect("find pool");
    println!(
        "pool ref = {}#{}  ada={} datum.asset_a={:?}",
        hex::encode(&pool.output_reference.transaction_id),
        pool.output_reference.output_index,
        pool.value.lovelace_of(),
        pool.datum.asset_a.name
    );
    assert!(pool.value.quantity_of(&nft.policy, &nft.name) == 1);
}

#[test]
#[ignore]
fn live_find_wallet_and_orders() {
    let b = backend();
    let solver = "addr_test1vq6vymyr2plj92javazvvxfqj5aaqxhk5u3u87ud4dc8u5gyasnly";
    let utxos = b.find_wallet_utxos(solver).expect("wallet utxos");
    let pure: Vec<_> = utxos.iter().filter(|u| u.is_pure_ada()).collect();
    println!("wallet utxos={} pure-ada={}", utxos.len(), pure.len());
    assert!(!utxos.is_empty());

    let orders = b
        .find_orders(&b.config().settlement_cred.clone())
        .expect("find orders");
    println!("orders found = {}", orders.len());
}

// tiny hex encoder for the println above (no dev-dep needed)
mod hex {
    pub fn encode(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
