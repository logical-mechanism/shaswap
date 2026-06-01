//! ShaSwap reference-solver orchestrator.
//!
//! A permissionless, **zero-config** solver loop against a live node (Kupo +
//! Ogmios behind the [`chain`] backend). It discovers everything itself — every
//! pool (one per `(asset_a, asset_b)` pair, any number, all under the same anchor
//! `S`), every order, and the solver's own wallet — so the only setup is: deploy,
//! fund the solver address with some ADA, and run.
//!
//! Each pass:
//! 1. **discover** — one atomic Kupo snapshot: all orders + all pools + wallet;
//! 2. **group** — orders by their target pool (`order.datum.pool_nft`);
//! 3. **solve** — `solver-core::solve` per pool (uniform price, netting, residual
//!    through the pool; floor-only v1);
//! 4. **chain** — assemble a CHAIN of settlement txs, ONE per settleable pool,
//!    each funded by the previous tx's change output. Each is gated by Ogmios
//!    `EvaluateTx` (with the previous tx's still-unconfirmed change supplied as
//!    `additionalUtxo`, since it isn't on-chain yet) and, when `SHASWAP_SUBMIT=1`,
//!    submitted back-to-back into the mempool (which accepts chained txs).
//!
//! A settlement tx settles ONE pool (the `SettlementRedeemer` carries one price +
//! pool), so the chain is many such txs. The collateral is **shared** across the
//! chain — a phase-2-passing tx never consumes its collateral, so it stays in the
//! mempool UTXO set for the next link (verified live; see MEMORY). This drains
//! every settleable pool in a single pass instead of one pool per block.
//!
//! Modes: one pass by default; `SHASWAP_INTERVAL_SECS=<n>` runs as a daemon that
//! polls Kupo's checkpoint every `n`s and settles only when a new block is indexed
//! (block-driven). Just-submitted orders are tracked in-flight so it never
//! double-spends before they confirm. Economically rational: a tx whose tips don't
//! cover its fee is skipped (its orders defer to a better-amortized batch).
//! `RUST_LOG` controls verbosity (default info).
//!
//! Config path: `$SHASWAP_DEPLOYMENT` or argv[1].

use chain::assemble::{self, AssembleInputs};
use chain::backend::{ChainBackend, Snapshot, Utxo};
use chain::config::{Config, ValidatedConfig};
use chain::fees;
use chain::kupo_ogmios::KupoOgmios;
use pallas_addresses::{Network, ShelleyAddress, ShelleyDelegationPart, ShelleyPaymentPart};
use pallas_crypto::hash::Hasher;
use pallas_crypto::key::ed25519::SecretKey;
use solver_core::output::{OrderInput, PoolInput};
use solver_core::types::OutputReference;
use solver_core::value::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// preprod genesis: system start 2022-06-01T00:00:00Z, 1s slots.
const SYSTEM_START_MS: i64 = 1_654_041_600_000;
const SLOT_LENGTH_MS: i64 = 1_000;
/// The dedicated collateral UTXO size the batcher provisions/uses (lovelace).
/// 5 ADA exceeds the worst-case requirement (max-fee × collateralPercentage) for
/// any tx on this network, since fee is bounded by max ex-units + max tx size.
const COLLATERAL_LOVELACE: u64 = 5_000_000;
/// Extra lovelace a settlement's tips must clear its fee by before the solver
/// will submit it. 0 = break-even floor (never submit a fee-negative tx); raise
/// it to demand a minimum per-tx profit. Under load many small tips amortize one
/// fee, so batching tip-bearing orders is what makes a tx clear this.
const FEE_COVER_MARGIN: u64 = 0;

type Err = Box<dyn std::error::Error>;
/// A UTXO identity (tx id, output index).
type Key = (Vec<u8>, u64);
/// An asset identity (policy, name) — used to key pools/orders by NFT.
type NftKey = (Vec<u8>, Vec<u8>);

fn key(r: &OutputReference) -> Key {
    (r.transaction_id.clone(), r.output_index)
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    if let Err(e) = run() {
        error!("{e}");
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
    info!(
        solver = %solver_addr,
        submit,
        mode = %interval.map_or("one-shot".into(), |n| format!("loop {n}s")),
        "starting"
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

    let mut state = LoopState::default();

    // One-shot: a single pass, propagate any error.
    let Some(poll) = interval else {
        return settle_once(
            &backend,
            &cfg,
            &skey,
            &solver_addr,
            ref_bytes,
            submit,
            &mut state,
        );
    };

    // Daemon: **block-driven**. Do a pass when Kupo's checkpoint advances (which
    // also guarantees Kupo has the block's data — no read-stale-data race against
    // the node tip); otherwise just cheaply re-poll. A transient failure logs and
    // waits for the next block rather than killing the daemon.
    let mut last_block: Option<u64> = None;
    loop {
        match backend.kupo_checkpoint() {
            Ok(cp) if last_block != Some(cp) => {
                if let Err(e) = settle_once(
                    &backend,
                    &cfg,
                    &skey,
                    &solver_addr,
                    ref_bytes,
                    submit,
                    &mut state,
                ) {
                    warn!("pass failed (will retry next block): {e}");
                }
                last_block = Some(cp);
            }
            Ok(_) => {} // no new block since last pass
            Err(e) => warn!("checkpoint poll failed (will retry): {e:?}"),
        }
        std::thread::sleep(Duration::from_secs(poll));
    }
}

/// Loop-carried state: orders we've submitted but not yet seen confirmed-spent,
/// and a round-robin cursor over pools so no pool is starved.
#[derive(Default)]
struct LoopState {
    in_flight: HashSet<Key>,
    cursor: usize,
}

/// One discover → group-by-pool → settle-one-pool pass.
fn settle_once(
    backend: &KupoOgmios,
    cfg: &ValidatedConfig,
    skey: &SecretKey,
    solver_addr: &str,
    ref_bytes: u64,
    submit: bool,
    state: &mut LoopState,
) -> Result<(), Err> {
    let tip = backend.tip().map_err(|e| format!("tip: {e:?}"))?;
    let params = backend
        .protocol_params()
        .map_err(|e| format!("params: {e:?}"))?;
    let Snapshot {
        orders: all_orders,
        pools,
        wallet,
    } = backend
        .discover(&cfg.settlement_cred, solver_addr)
        .map_err(|e| format!("discover: {e:?}"))?;

    // Drop in-flight entries that have confirmed (no longer present), then exclude
    // the still-pending ones from this pass so we never double-spend.
    let present: HashSet<Key> = all_orders
        .iter()
        .map(|o| key(&o.output_reference))
        .collect();
    state.in_flight.retain(|k| present.contains(k));
    let orders: Vec<OrderInput> = all_orders
        .into_iter()
        .filter(|o| !state.in_flight.contains(&key(&o.output_reference)))
        .collect();

    info!(
        slot = tip.slot,
        pools = pools.len(),
        orders = orders.len(),
        in_flight = state.in_flight.len(),
        wallet = wallet.len(),
        "discovered"
    );

    // Group settleable orders by their target pool NFT.
    let mut by_pool: HashMap<NftKey, Vec<OrderInput>> = HashMap::new();
    for o in orders {
        by_pool
            .entry(nft_key(&o.datum.pool_nft))
            .or_default()
            .push(o);
    }
    let pool_nfts: Vec<NftKey> = pools.iter().map(|p| nft_key(&p.datum.nft)).collect();
    let order_nfts: Vec<NftKey> = by_pool.keys().cloned().collect();

    // Decide which pools to attempt, in what order (deterministic + round-robin
    // fair), and which orders are orphans (target a pool we don't see).
    let (attempt, orphans) = settlement_plan(&pool_nfts, &order_nfts, state.cursor);
    for nft in &orphans {
        warn!(
            nft = hex::encode(&nft.0),
            "orders target a pool not found on-chain; skipping"
        );
    }
    if attempt.is_empty() {
        debug!("nothing to settle this pass");
        return Ok(());
    }

    // Build a CHAIN of settlement txs — one per settleable pool — in one pass,
    // each funded by the previous tx's change output and submitted back-to-back
    // into the mempool (which accepts chained txs). This drains every settleable
    // pool as fast as the chain allows instead of one pool per block. The chain's
    // funding starts at the solver's on-chain funding UTXO; the collateral is
    // shared across the chain (a phase-2-passing tx never consumes its collateral,
    // so it stays in the mempool UTXO set for the next tx — see MEMORY).
    let (funding0, collateral0) = select_inputs(&wallet)?;
    let mut chain = ChainCtx {
        funding: (funding0.output_reference.clone(), funding0.value.clone()),
        collateral: collateral0.output_reference.clone(),
        resolved: Vec::new(),
    };

    let mut settled = 0usize;
    for pi in attempt {
        let pool = &pools[pi];
        let ords = &by_pool[&pool_nfts[pi]];
        match try_settle_pool(
            backend,
            cfg,
            skey,
            solver_addr,
            ref_bytes,
            &params,
            pool,
            ords,
            submit,
            &mut chain,
            &mut state.in_flight,
        ) {
            Ok(true) => settled += 1,
            Ok(false) => continue, // no valid / fee-covering clearing for this pool
            Err(e) => {
                // A failed tx just doesn't advance the chain; the rolling funding
                // is unchanged, so the next pool retries from the same UTXO.
                warn!(
                    nft = hex::encode(&pool.datum.nft.policy),
                    "settle failed: {e}"
                );
                continue;
            }
        }
    }
    // Rotate the lead pool each pass so a persistently-unsolvable pool can't pin
    // the chain order (round-robin fairness, retained from the one-per-block era).
    state.cursor = state.cursor.wrapping_add(1);
    if settled == 0 {
        debug!("no pool produced a settlement this pass");
    } else {
        info!(settled, "chained settlements this pass");
    }
    Ok(())
}

/// Rolling state for a chain of settlement txs built within one pass. `funding`
/// starts at the solver's on-chain funding UTXO and advances to each tx's change
/// output; `collateral` is shared across the chain; `resolved` accumulates every
/// in-flight change output to supply as `additionalUtxo` so each tx's `EvaluateTx`
/// can resolve its not-yet-confirmed funding ancestor.
struct ChainCtx {
    funding: (OutputReference, Value),
    collateral: OutputReference,
    resolved: Vec<chain::backend::ResolvedUtxo>,
}

fn nft_key(a: &solver_core::types::AssetId) -> NftKey {
    (a.policy.clone(), a.name.clone())
}

/// Decide the per-pass settlement plan (pure policy, no IO): which pools to attempt
/// and in what order, plus which order NFTs are orphans.
///
/// Returns `(attempt, orphans)` where `attempt` is indices into `pool_nfts` for the
/// pools that have at least one settleable order — sorted deterministically by NFT,
/// then rotated by `cursor` so no pool is starved across passes — and `orphans` is
/// the order NFTs that match no known pool (deduped, sorted; logged, never settled).
fn settlement_plan(
    pool_nfts: &[NftKey],
    order_nfts: &[NftKey],
    cursor: usize,
) -> (Vec<usize>, Vec<NftKey>) {
    let have: HashSet<&NftKey> = order_nfts.iter().collect();
    let mut attempt: Vec<usize> = (0..pool_nfts.len())
        .filter(|&i| have.contains(&pool_nfts[i]))
        .collect();
    attempt.sort_by(|&a, &b| pool_nfts[a].cmp(&pool_nfts[b]));
    let len = attempt.len();
    if len > 0 {
        attempt.rotate_left(cursor % len);
    }

    let pool_set: HashSet<&NftKey> = pool_nfts.iter().collect();
    let mut orphans: Vec<NftKey> = order_nfts
        .iter()
        .filter(|n| !pool_set.contains(n))
        .cloned()
        .collect();
    orphans.sort();
    orphans.dedup();

    (attempt, orphans)
}

/// Solve + assemble + (submit) one pool's batch as the next link in a tx chain.
/// On success advances `chain` (this tx's change becomes the next tx's funding and
/// is recorded as an `additionalUtxo` ancestor). Returns `Ok(true)` if a settlement
/// was built (and submitted, when enabled), `Ok(false)` if the pool had no valid
/// (or no fee-covering) clearing.
#[allow(clippy::too_many_arguments)]
fn try_settle_pool(
    backend: &KupoOgmios,
    cfg: &ValidatedConfig,
    skey: &SecretKey,
    solver_addr: &str,
    ref_bytes: u64,
    params: &chain::backend::ProtocolParams,
    pool: &PoolInput,
    orders: &[OrderInput],
    submit: bool,
    chain: &mut ChainCtx,
    in_flight: &mut HashSet<Key>,
) -> Result<bool, Err> {
    let nft = hex::encode(&pool.datum.nft.policy);
    let Some(solved) = solver_core::solve::solve(orders, pool) else {
        debug!(nft, orders = orders.len(), "no valid clearing");
        return Ok(false);
    };
    info!(
        nft,
        price = format!("{}/{}", solved.price.num, solved.price.den),
        included = format!("{}/{}", solved.orders.len(), orders.len()),
        net_a = solved.settlement.net_a,
        net_b = solved.settlement.net_b,
        tip_take = solved.settlement.tip_taken_total,
        "solved"
    );

    let invalid_after_slot = solved
        .orders
        .iter()
        .filter_map(|o| o.datum.deadline)
        .min()
        .map(|d| fees::posix_to_slot(d, SYSTEM_START_MS, SLOT_LENGTH_MS));
    // Fund this link from the rolling chain funding (the solver's on-chain UTXO
    // for the first tx, then each previous tx's change output).
    let funding_pairs: Vec<(_, Value)> = vec![chain.funding.clone()];

    let inp = AssembleInputs {
        settlement: &solved.settlement,
        orders: &solved.orders,
        pool,
        funding: &funding_pairs,
        collateral: &chain.collateral,
        solver_addr_bech32: solver_addr,
        config: cfg,
        params,
        ref_script_total_bytes: ref_bytes,
        invalid_after_slot,
    };
    // Resolve this tx's not-yet-confirmed funding ancestor(s) at the gate.
    let built = assemble::build_signed(&inp, backend, skey, &chain.resolved)
        .map_err(|e| format!("assemble: {e:?}"))?;

    // Economically rational: a reference solver shouldn't burn ADA settling a
    // batch whose tips don't cover its fee. Skip a fee-negative tx (don't advance
    // the chain) so its orders stay for a later, better-amortized batch.
    if solved.settlement.tip_taken_total < built.fee as i128 + FEE_COVER_MARGIN as i128 {
        info!(
            nft,
            tip_take = solved.settlement.tip_taken_total,
            fee = built.fee,
            "skip: tips do not cover fee (+margin); deferring orders"
        );
        return Ok(false);
    }
    info!(
        nft,
        tx = hex::encode(built.signed.tx_hash.0),
        fee = built.fee,
        mem = built.total_ex_units.mem,
        steps = built.total_ex_units.steps,
        "built + evaluated OK (gate passed)"
    );

    if submit {
        let txid = backend
            .submit(&built.signed.tx_bytes.0)
            .map_err(|e| format!("submit: {e:?}"))?;
        for o in &solved.orders {
            in_flight.insert(key(&o.output_reference));
        }
        info!(nft, tx = hex::encode(&txid), "SUBMITTED");
    } else {
        info!(
            nft,
            bytes = built.signed.tx_bytes.0.len(),
            "dry run (set SHASWAP_SUBMIT=1 to submit)"
        );
    }

    // Advance the chain: this tx's change funds the next link and is supplied as
    // an `additionalUtxo` ancestor so the next tx's gate can resolve it. Done in
    // dry-run too, so a full chain is built + gated end-to-end without submitting.
    chain.funding = (
        built.change.output_reference.clone(),
        built.change.value.clone(),
    );
    chain.resolved.push(built.change);
    Ok(true)
}

/// Pick the solver's funding + collateral UTXOs. Collateral must be pure-ADA (no
/// datum/tokens/ref-script) and ≥ 5 ADA — which exceeds the worst-case collateral
/// requirement (fee × `collateralPercentage`) for ANY tx on this network, since
/// fee is bounded by the max ex-units + max tx size. Funding is the largest UTXO
/// that isn't a reference script and isn't the collateral (its leftover — incl.
/// any tokens — returns as change).
fn select_inputs(wallet: &[Utxo]) -> Result<(&Utxo, &Utxo), Err> {
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
    info!(
        tx = hex::encode(&txid),
        from = format!(
            "{}#{}",
            hex::encode(&src.output_reference.transaction_id),
            src.output_reference.output_index
        ),
        "provisioned 5-ADA collateral"
    );

    for _ in 0..30 {
        std::thread::sleep(Duration::from_secs(5));
        let w = backend
            .find_wallet_utxos(solver_addr)
            .map_err(|e| format!("wallet: {e:?}"))?;
        if select_inputs(&w).is_ok() {
            info!("collateral confirmed; wallet ready");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn nft(b: u8) -> NftKey {
        (vec![b; 28], b"NFT".to_vec())
    }

    #[test]
    fn plan_picks_only_pools_with_orders() {
        let pools = [nft(1), nft(2), nft(3)];
        // orders for pools 1 and 3 only.
        let orders = [nft(3), nft(1)];
        let (attempt, orphans) = settlement_plan(&pools, &orders, 0);
        // sorted by nft -> pool index 0 (nft1), 2 (nft3).
        assert_eq!(attempt, vec![0, 2]);
        assert!(orphans.is_empty());
    }

    #[test]
    fn plan_rotates_by_cursor_for_fairness() {
        let pools = [nft(1), nft(2), nft(3)];
        let orders = [nft(1), nft(2), nft(3)];
        assert_eq!(settlement_plan(&pools, &orders, 0).0, vec![0, 1, 2]);
        assert_eq!(settlement_plan(&pools, &orders, 1).0, vec![1, 2, 0]);
        assert_eq!(settlement_plan(&pools, &orders, 2).0, vec![2, 0, 1]);
        // cursor wraps past the candidate count.
        assert_eq!(settlement_plan(&pools, &orders, 3).0, vec![0, 1, 2]);
    }

    #[test]
    fn plan_reports_orphans_and_skips_them() {
        let pools = [nft(1)];
        // orders for the known pool (1) and two unknown pools (7, 8).
        let orders = [nft(7), nft(1), nft(8), nft(7)];
        let (attempt, orphans) = settlement_plan(&pools, &orders, 0);
        assert_eq!(attempt, vec![0]); // only the known pool is attempted
        assert_eq!(orphans, vec![nft(7), nft(8)]); // deduped + sorted, never settled
    }

    #[test]
    fn plan_empty_when_no_orders_match_any_pool() {
        let pools = [nft(1), nft(2)];
        let orders = [nft(9)];
        let (attempt, orphans) = settlement_plan(&pools, &orders, 5);
        assert!(attempt.is_empty());
        assert_eq!(orphans, vec![nft(9)]);
    }
}
