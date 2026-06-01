//! ShaSwap reference-solver orchestrator.
//!
//! The permissionless solver loop against a live preprod node (Kupo + Ogmios
//! behind the [`chain`] backend):
//!
//! 1. **discover** — one atomic snapshot: order UTXOs (tagged `S`) + the pool (by
//!    NFT) + the solver's wallet (funding/collateral), via Kupo `discover`;
//! 2. **solve** — `solver-core::solve` picks a uniform price, nets opposing orders,
//!    routes the residual through the pool (floor-only v1);
//! 3. **assemble** — lower the settlement into the withdraw-0 Conway tx;
//! 4. **evaluate** — Ogmios `EvaluateTx` fills ex-units AND is the pre-submit gate
//!    (the on-chain validators must accept the tx phase-2);
//! 5. **submit** — only when `SHASWAP_SUBMIT=1` (otherwise a dry run: build +
//!    evaluate + print, for cross-checking before going live).
//!
//! Runs one pass by default. Set `SHASWAP_INTERVAL_SECS=<n>` to run as a daemon:
//! it polls Kupo's checkpoint every `n` seconds and does a settle pass **only when
//! a new block has been indexed** (block-driven, not a blind timer — no wasted work
//! between blocks, and no reading stale data ahead of Kupo). The loop tracks
//! just-submitted orders as in-flight and won't re-settle them until they confirm
//! (drop out of discovery), so it never double-spends.
//!
//! Config path: `$SHASWAP_DEPLOYMENT` or argv[1] (default
//! `../contracts/happy_path/deployment.json`).

use chain::assemble::{self, AssembleInputs};
use chain::backend::{ChainBackend, Snapshot};
use chain::config::{Config, ValidatedConfig};
use chain::fees;
use chain::kupo_ogmios::KupoOgmios;
use pallas_addresses::{Network, ShelleyAddress, ShelleyDelegationPart, ShelleyPaymentPart};
use pallas_crypto::hash::Hasher;
use pallas_crypto::key::ed25519::SecretKey;
use solver_core::types::OutputReference;
use solver_core::value::Value;
use std::collections::HashSet;
use std::time::Duration;

/// preprod genesis: system start 2022-06-01T00:00:00Z, 1s slots.
const SYSTEM_START_MS: i64 = 1_654_041_600_000;
const SLOT_LENGTH_MS: i64 = 1_000;
/// The dedicated collateral UTXO size the batcher provisions/uses (lovelace).
/// 5 ADA exceeds the worst-case requirement (max-fee × collateralPercentage) for
/// any tx on this network, since fee is bounded by max ex-units + max tx size.
const COLLATERAL_LOVELACE: u64 = 5_000_000;

type Err = Box<dyn std::error::Error>;
type Key = (Vec<u8>, u64);

fn key(r: &OutputReference) -> Key {
    (r.transaction_id.clone(), r.output_index)
}

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
    let submit = std::env::var("SHASWAP_SUBMIT").as_deref() == Ok("1");
    let interval = std::env::var("SHASWAP_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0);
    println!(
        "solver address: {solver_addr} | submit={} | mode={}",
        submit,
        interval.map_or("one-shot".into(), |n| format!("loop {n}s")),
    );

    // The reference-script sizes never change for a fixed deployment — fetch once.
    let ref_bytes = backend
        .ref_script_total_bytes()
        .map_err(|e| format!("ref script sizes: {e:?}"))?;

    // Turnkey bootstrap: a settlement needs a funding input AND a distinct
    // collateral input (≥2 wallet UTXOs). If the operator funded the address as a
    // single lump, self-provision a dedicated collateral UTXO once. After that the
    // wallet self-maintains (settlements regenerate funding-change; collateral is
    // never spent on success).
    ensure_collateral(&backend, &skey, &solver_addr, submit)?;

    // Orders we've submitted but not yet seen confirmed-spent (loop only).
    let mut in_flight: HashSet<Key> = HashSet::new();

    // One-shot: a single pass, propagate any error.
    let Some(poll) = interval else {
        return settle_once(
            &backend,
            &cfg,
            &skey,
            &solver_addr,
            ref_bytes,
            submit,
            &mut in_flight,
        );
    };

    // Loop: **block-driven**. Chain state only changes on a new block, so we do a
    // pass exactly when Kupo's checkpoint advances (which also means Kupo has that
    // block's data — no read-stale-data race against the node tip), and otherwise
    // just cheaply re-poll the checkpoint every `poll` seconds. A transient pass
    // failure logs and waits for the next block rather than killing the daemon.
    let mut last_block: Option<u64> = None;
    loop {
        match backend.kupo_checkpoint() {
            // New block indexed (or first iteration, or a rollback) → settle.
            Ok(cp) if last_block != Some(cp) => {
                if let Err(e) = settle_once(
                    &backend,
                    &cfg,
                    &skey,
                    &solver_addr,
                    ref_bytes,
                    submit,
                    &mut in_flight,
                ) {
                    eprintln!("pass failed (will retry next block): {e}");
                }
                last_block = Some(cp);
            }
            Ok(_) => {} // no new block since last pass — nothing to do
            Err(e) => eprintln!("checkpoint poll failed (will retry): {e:?}"),
        }
        std::thread::sleep(Duration::from_secs(poll));
    }
}

/// One discover → solve → assemble → evaluate → (submit) pass.
fn settle_once(
    backend: &KupoOgmios,
    cfg: &ValidatedConfig,
    skey: &SecretKey,
    solver_addr: &str,
    ref_bytes: u64,
    submit: bool,
    in_flight: &mut HashSet<Key>,
) -> Result<(), Err> {
    let tip = backend.tip().map_err(|e| format!("tip: {e:?}"))?;
    let params = backend
        .protocol_params()
        .map_err(|e| format!("params: {e:?}"))?;
    let Snapshot {
        orders: all_orders,
        pool,
        wallet,
    } = backend
        .discover(&cfg.settlement_cred, &cfg.pool_nft, solver_addr)
        .map_err(|e| format!("discover: {e:?}"))?;

    // Drop in-flight entries that have confirmed (no longer present).
    let present: HashSet<Key> = all_orders
        .iter()
        .map(|o| key(&o.output_reference))
        .collect();
    in_flight.retain(|k| present.contains(k));
    // Don't re-settle orders we've already submitted and are awaiting confirmation.
    let orders: Vec<_> = all_orders
        .into_iter()
        .filter(|o| !in_flight.contains(&key(&o.output_reference)))
        .collect();

    println!(
        "tip slot {} | settleable orders {} ({} in-flight) | pool {}#{} ada={} | wallet {} utxos",
        tip.slot,
        orders.len(),
        in_flight.len(),
        hex::encode(&pool.output_reference.transaction_id),
        pool.output_reference.output_index,
        pool.value.lovelace_of(),
        wallet.len(),
    );
    if orders.is_empty() {
        println!("  nothing to settle this pass.");
        return Ok(());
    }
    for (i, o) in orders.iter().enumerate() {
        println!(
            "  order[{i}] {}#{} sell_a={} sell={} limit={} tip={}",
            hex::encode(&o.output_reference.transaction_id),
            o.output_reference.output_index,
            o.datum.sell_a,
            o.datum.sell_amount,
            o.datum.limit,
            o.datum.tip,
        );
    }

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

    let (funding, collateral) = select_inputs(&wallet)?;
    println!(
        "funding {}#{} ada={} | collateral {}#{} ada={}",
        hex::encode(&funding.output_reference.transaction_id),
        funding.output_reference.output_index,
        funding.value.lovelace_of(),
        hex::encode(&collateral.output_reference.transaction_id),
        collateral.output_reference.output_index,
        collateral.value.lovelace_of(),
    );

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
        solver_addr_bech32: solver_addr,
        config: cfg,
        params: &params,
        ref_script_total_bytes: ref_bytes,
        invalid_after_slot,
    };

    let built =
        assemble::build_signed(&inp, backend, skey).map_err(|e| format!("assemble: {e:?}"))?;
    println!(
        "built + evaluated OK (gate passed): tx {} | fee {} | ex-units mem={} steps={} | ref_bytes {}",
        hex::encode(built.signed.tx_hash.0),
        built.fee,
        built.total_ex_units.mem,
        built.total_ex_units.steps,
        ref_bytes,
    );

    if submit {
        let txid = backend
            .submit(&built.signed.tx_bytes.0)
            .map_err(|e| format!("submit: {e:?}"))?;
        // Mark the settled orders in-flight so the next pass skips them until they
        // confirm (and thus disappear from discovery).
        for o in &solved.orders {
            in_flight.insert(key(&o.output_reference));
        }
        println!("SUBMITTED settlement tx {}", hex::encode(&txid));
    } else {
        println!(
            "dry run (set SHASWAP_SUBMIT=1 to submit). Signed tx: {} bytes",
            built.signed.tx_bytes.0.len()
        );
    }
    Ok(())
}

/// Pick the solver's funding + collateral UTXOs. Collateral must be pure-ADA (no
/// datum/tokens/ref-script) and ≥ 5 ADA — which exceeds the worst-case collateral
/// requirement (fee × `collateralPercentage`) for ANY tx on this network, since
/// fee is bounded by the max ex-units + max tx size. Funding is the largest UTXO
/// that isn't a reference script and isn't the collateral (its leftover — incl.
/// any tokens — returns as change).
fn select_inputs(
    wallet: &[chain::backend::Utxo],
) -> Result<(&chain::backend::Utxo, &chain::backend::Utxo), Err> {
    let collateral = wallet
        .iter()
        .filter(|u| u.is_pure_ada() && u.value.lovelace_of() >= COLLATERAL_LOVELACE as i128)
        .min_by_key(|u| u.value.lovelace_of())
        .ok_or("no pure-ADA collateral UTXO >= 5 ADA")?;
    let funding = wallet
        .iter()
        .filter(|u| !u.has_reference_script && u.output_reference != collateral.output_reference)
        .max_by_key(|u| u.value.lovelace_of())
        .ok_or("no funding UTXO (distinct from collateral)")?;
    Ok((funding, collateral))
}

/// Ensure the solver wallet can supply both a funding input and a distinct
/// collateral input. If [`select_inputs`] already succeeds, do nothing. Otherwise
/// (single lump, or no pure-ADA collateral), submit a one-time split tx that
/// carves a dedicated `COLLATERAL_LOVELACE` UTXO, then wait for it to confirm.
fn ensure_collateral(
    backend: &KupoOgmios,
    skey: &SecretKey,
    solver_addr: &str,
    submit: bool,
) -> Result<(), Err> {
    let wallet = backend
        .find_wallet_utxos(solver_addr)
        .map_err(|e| format!("wallet: {e:?}"))?;
    if select_inputs(&wallet).is_ok() {
        return Ok(()); // already have funding + a distinct collateral
    }
    if !submit {
        return Err(
            "wallet lacks a funding + distinct collateral UTXO. Re-run with \
             SHASWAP_SUBMIT=1 to auto-provision a 5-ADA collateral, or fund the solver \
             address with a second UTXO."
                .into(),
        );
    }

    // Split the largest spendable UTXO into [5-ADA collateral, change].
    let params = backend
        .protocol_params()
        .map_err(|e| format!("params: {e:?}"))?;
    let src = wallet
        .iter()
        .filter(|u| !u.has_reference_script)
        .max_by_key(|u| u.value.lovelace_of())
        .ok_or("no spendable UTXO to provision collateral from")?;
    // collateral + a min-ADA change + fee headroom.
    let need = COLLATERAL_LOVELACE as i128 + 2_000_000 + 1_000_000;
    if src.value.lovelace_of() < need {
        return Err(format!(
            "largest UTXO ({} lovelace) too small to provision a 5-ADA collateral",
            src.value.lovelace_of()
        )
        .into());
    }
    let signed = assemble::build_collateral_split(
        &src.output_reference,
        &src.value,
        solver_addr,
        COLLATERAL_LOVELACE,
        &params,
        skey,
    )
    .map_err(|e| format!("build split: {e:?}"))?;
    let txid = backend
        .submit(&signed.tx_bytes.0)
        .map_err(|e| format!("submit split: {e:?}"))?;
    println!(
        "provisioned collateral: split tx {} (carving 5 ADA from {}#{})",
        hex::encode(&txid),
        hex::encode(&src.output_reference.transaction_id),
        src.output_reference.output_index
    );

    // Wait for the split to confirm (until the wallet can supply both inputs).
    for _ in 0..30 {
        std::thread::sleep(Duration::from_secs(5));
        let w = backend
            .find_wallet_utxos(solver_addr)
            .map_err(|e| format!("wallet: {e:?}"))?;
        if select_inputs(&w).is_ok() {
            println!("collateral confirmed; wallet ready.");
            return Ok(());
        }
    }
    Err("timed out waiting for the collateral split to confirm".into())
}

/// Derive the solver's enterprise (payment-only) bech32 address from its signing
/// key — payment credential = blake2b-224 of the ed25519 public key.
fn solver_address(network_id: u8, skey: &SecretKey) -> Result<String, Err> {
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
