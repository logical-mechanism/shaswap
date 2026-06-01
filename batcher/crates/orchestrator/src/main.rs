//! ShaSwap reference-solver orchestrator.
//!
//! One pass of the permissionless solver loop against a live preprod node
//! (Kupo + Ogmios behind the [`chain`] backend):
//!
//! 1. **discover** — order UTXOs (tagged `S`) + the pool (by NFT) + the solver's
//!    wallet (for funding/collateral), all via Kupo;
//! 2. **solve** — `solver-core::solve` picks a uniform price, nets opposing orders,
//!    routes the residual through the pool (floor-only v1);
//! 3. **assemble** — lower the settlement into the withdraw-0 Conway tx;
//! 4. **evaluate** — Ogmios `EvaluateTx` fills ex-units AND is the pre-submit gate
//!    (the on-chain validators must accept the tx phase-2);
//! 5. **submit** — only when `SHASWAP_SUBMIT=1` (otherwise a safe dry run that
//!    builds + evaluates + prints, for cross-checking before going live).
//!
//! Config path: `$SHASWAP_DEPLOYMENT` or argv[1] (default
//! `../contracts/happy_path/deployment.json`).

use chain::assemble::{self, AssembleInputs};
use chain::backend::ChainBackend;
use chain::config::Config;
use chain::fees;
use chain::kupo_ogmios::KupoOgmios;
use pallas_addresses::{Network, ShelleyAddress, ShelleyDelegationPart, ShelleyPaymentPart};
use pallas_crypto::hash::Hasher;
use solver_core::value::Value;

/// preprod genesis: system start 2022-06-01T00:00:00Z, 1s slots.
const SYSTEM_START_MS: i64 = 1_654_041_600_000;
const SLOT_LENGTH_MS: i64 = 1_000;

type Err = Box<dyn std::error::Error>;

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Err> {
    let path = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("SHASWAP_DEPLOYMENT").ok())
        .unwrap_or_else(|| "../contracts/happy_path/deployment.json".to_string());
    let json = std::fs::read_to_string(&path)?;
    let raw: Config = serde_json::from_str(&json)?;
    let signing_key_path = raw.signing_key_path.clone();
    let network_id = raw.network_id;
    let cfg = raw
        .validate()
        .map_err(|e| format!("config validation: {e:?}"))?;

    let backend = KupoOgmios::new(cfg.clone()).map_err(|e| format!("backend: {e:?}"))?;
    let skey = assemble::load_signing_key(&signing_key_path).map_err(|e| format!("skey: {e:?}"))?;
    let solver_addr = solver_address(network_id, &skey)?;
    println!("solver address: {solver_addr}");

    // 1. discover --------------------------------------------------------------
    let tip = backend.tip().map_err(|e| format!("tip: {e:?}"))?;
    let params = backend
        .protocol_params()
        .map_err(|e| format!("params: {e:?}"))?;
    let orders = backend
        .find_orders(&cfg.settlement_cred)
        .map_err(|e| format!("find_orders: {e:?}"))?;
    let pool = backend
        .find_pool(&cfg.pool_nft)
        .map_err(|e| format!("find_pool: {e:?}"))?;
    let wallet = backend
        .find_wallet_utxos(&solver_addr)
        .map_err(|e| format!("wallet: {e:?}"))?;

    println!(
        "tip slot {} | orders {} | pool {}#{} ada={} | wallet {} utxos",
        tip.slot,
        orders.len(),
        hex(&pool.output_reference.transaction_id),
        pool.output_reference.output_index,
        pool.value.lovelace_of(),
        wallet.len(),
    );
    for (i, o) in orders.iter().enumerate() {
        println!(
            "  order[{i}] {}#{} sell_a={} sell={} limit={} tip={}",
            hex(&o.output_reference.transaction_id),
            o.output_reference.output_index,
            o.datum.sell_a,
            o.datum.sell_amount,
            o.datum.limit,
            o.datum.tip,
        );
    }
    if orders.is_empty() {
        println!("no orders to settle — nothing to do.");
        return Ok(());
    }

    // 2. solve -----------------------------------------------------------------
    let solved = solver_core::solve::solve(&orders, &pool)
        .ok_or("solver found no valid clearing for this batch")?;
    println!(
        "solved: price {}/{} | included {}/{} | cleared_a {} | net_a {} net_b {} | tip_take {}",
        solved.price.num,
        solved.price.den,
        solved.orders.len(),
        orders.len(),
        solved.cleared_volume_a,
        solved.settlement.net_a,
        solved.settlement.net_b,
        solved.settlement.tip_taken_total,
    );

    // 3. select funding + collateral ------------------------------------------
    let collateral = wallet
        .iter()
        .filter(|u| u.is_pure_ada() && u.value.lovelace_of() >= 5_000_000)
        .min_by_key(|u| u.value.lovelace_of())
        .ok_or("no pure-ADA collateral UTXO >= 5 ADA")?;
    let funding = wallet
        .iter()
        .filter(|u| !u.has_reference_script && u.output_reference != collateral.output_reference)
        .max_by_key(|u| u.value.lovelace_of())
        .ok_or("no funding UTXO (distinct from collateral)")?;
    println!(
        "funding {}#{} ada={} | collateral {}#{} ada={}",
        hex(&funding.output_reference.transaction_id),
        funding.output_reference.output_index,
        funding.value.lovelace_of(),
        hex(&collateral.output_reference.transaction_id),
        collateral.output_reference.output_index,
        collateral.value.lovelace_of(),
    );

    // 4. assemble --------------------------------------------------------------
    let ref_bytes = backend
        .ref_script_total_bytes()
        .map_err(|e| format!("ref script sizes: {e:?}"))?;
    let invalid_after_slot = solved
        .orders
        .iter()
        .filter_map(|o| o.datum.deadline)
        .min()
        .map(|d| fees::posix_to_slot(d, SYSTEM_START_MS, SLOT_LENGTH_MS));
    let funding_pairs: Vec<(_, Value)> =
        vec![(funding.output_reference.clone(), funding.value.clone())];

    let inp = AssembleInputs {
        settlement: &solved.settlement,
        orders: &solved.orders,
        pool: &pool,
        funding: &funding_pairs,
        collateral: &collateral.output_reference,
        solver_addr_bech32: &solver_addr,
        config: &cfg,
        params: &params,
        ref_script_total_bytes: ref_bytes,
        invalid_after_slot,
    };

    let built =
        assemble::build_signed(&inp, &backend, &skey).map_err(|e| format!("assemble: {e:?}"))?;
    println!(
        "built + evaluated OK (gate passed): tx {} | fee {} | ex-units mem={} steps={} | ref_bytes {}",
        hex(&built.signed.tx_hash.0),
        built.fee,
        built.total_ex_units.mem,
        built.total_ex_units.steps,
        ref_bytes,
    );

    // 5. submit (guarded) ------------------------------------------------------
    if std::env::var("SHASWAP_SUBMIT").as_deref() == Ok("1") {
        let txid = backend
            .submit(&built.signed.tx_bytes.0)
            .map_err(|e| format!("submit: {e:?}"))?;
        println!("SUBMITTED settlement tx {}", hex(&txid));
    } else {
        println!(
            "dry run (set SHASWAP_SUBMIT=1 to submit). Signed tx bytes: {} bytes",
            built.signed.tx_bytes.0.len()
        );
    }
    Ok(())
}

/// Derive the solver's enterprise (payment-only) bech32 address from its signing
/// key — payment credential = blake2b-224 of the ed25519 public key.
fn solver_address(
    network_id: u8,
    skey: &pallas_crypto::key::ed25519::SecretKey,
) -> Result<String, Err> {
    let pk = skey.public_key();
    let pkh = Hasher::<224>::hash(pk.as_ref());
    let net = Network::from(network_id);
    let addr = ShelleyAddress::new(
        net,
        ShelleyPaymentPart::Key(pkh),
        ShelleyDelegationPart::Null,
    );
    Ok(addr.to_bech32()?)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
