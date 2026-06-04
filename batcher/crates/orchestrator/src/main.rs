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
//! 4. **chain** — assemble a CHAIN of settlement txs, each funded by the previous
//!    tx's change output. Every settleable pool contributes ≥1 tx, and a pool with
//!    more than `max_orders_per_tx` settleable orders is itself drained over
//!    several chained txs (k capped batches, each re-solved against the previous
//!    batch's pool-continuation output). Each tx is gated by Ogmios `EvaluateTx`
//!    (with the previous tx's still-unconfirmed change + pool output supplied as
//!    `additionalUtxo`, since they aren't on-chain yet) and, when `SHASWAP_SUBMIT=1`,
//!    submitted back-to-back into the mempool (which accepts chained txs).
//!
//! A settlement tx settles ONE pool at ONE price (the `SettlementRedeemer` carries
//! one price + pool), so the chain is many such txs. The collateral is **shared**
//! across the chain — a phase-2-passing tx never consumes its collateral, so it
//! stays in the mempool UTXO set for the next link (verified live; see MEMORY).
//! This drains the whole settleable orderbook in a single pass instead of one pool
//! per block.
//!
//! Modes: one pass by default; `SHASWAP_INTERVAL_MS=<n>` (or `_SECS`, back-compat)
//! runs as a daemon that polls Kupo's checkpoint and settles only when a new block
//! is indexed (block-driven). The poll is a cheap `/checkpoints` GET keyed off
//! Kupo's checkpoint, so polling fast is safe (never reads ahead of what Kupo
//! indexed) and reactive — fast by default; the latency floor is Kupo's index lag,
//! not the cadence. `SIGTERM`/`SIGINT` shut the daemon down cleanly between passes
//! (systemd-friendly; a signal never interrupts a pass mid-submit). Every input
//! spent by a submitted-but-unconfirmed tx (settled order refs AND the wallet
//! funding UTXO) is held `pending` and excluded from the next pass, so an in-flight
//! chain is never double-spent before it confirms; entries expire after a grace
//! window so a failed/never-confirmed tx's inputs are retried (recovery). A submit
//! failure aborts the whole pass (the rolling funding is then ambiguous). Every
//! built tx is `isValid == true` (the builder cannot emit `false`) and is gated by
//! `EvaluateTx` before submit, so the node accepts it phase-2 and the collateral is
//! never consumed. Economically rational: a tx whose tips don't cover its fee is
//! skipped. Funding selection takes only ada-only UTXOs (dust/token-poisoning
//! defense). The per-tx order cap (`max_orders_per_tx`, default 20) and drain
//! `strategy` come from the deployment JSON (env overrides `SHASWAP_MAX_ORDERS_PER_TX`,
//! `SHASWAP_STRATEGY`). A running wallet-balance P&L is logged each pass. `RUST_LOG`
//! controls verbosity.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
/// How long (slots) an order/funding UTXO stays "pending" after we submit a tx
/// spending it. While pending it is excluded from settlement + funding selection
/// so we never double-spend a still-unconfirmed input. A submitted settlement
/// confirms within a few blocks; if a UTXO is still pending after this window the
/// tx almost certainly failed (rejected/evicted, or a chained ancestor died), so
/// the entry expires and the input is retried — the recovery path that keeps
/// orders from being stranded forever and bounds a chain's blast radius to one
/// grace window. ~3 min on preprod (1s slots, ~20s blocks).
const PENDING_GRACE_SLOTS: u64 = 180;

type Err = Box<dyn std::error::Error>;
/// A UTXO identity (tx id, output index).
type Key = (Vec<u8>, u64);
/// An asset identity (policy, name) — used to key pools/orders by NFT.
type NftKey = (Vec<u8>, Vec<u8>);

/// The cross-pool/shard drain ordering for a pass — the order pools are attempted
/// in when building the chain. It only affects *ordering* (and so, under multiple
/// competing solvers, who tends to win which pool and how fast); it never changes
/// which orders are batchable (that's the per-order floor + the fee-cover gate,
/// identical for every strategy). Add fancier policies as new variants here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Strategy {
    /// Sorted by NFT then rotated by a per-pass cursor: fair, deterministic, no
    /// pool starved — and across competing solvers it de-correlates collisions.
    #[default]
    RoundRobin,
    /// Highest Σtips first (deterministic NFT tie-break): clears the most valuable
    /// pools soonest. Individually rational, but if every solver does it they herd
    /// on the richest pool; a mixed population self-balances (see MEMORY/discussion).
    ProfitGreedy,
}

impl Strategy {
    /// Parse a config/env string; `None` if unrecognized (caller falls back).
    fn parse(s: &str) -> Option<Self> {
        match s
            .trim()
            .to_ascii_lowercase()
            .replace([' ', '_'], "-")
            .as_str()
        {
            "round-robin" | "roundrobin" | "rr" => Some(Strategy::RoundRobin),
            "profit-greedy" | "profitgreedy" | "greedy" | "profit" => Some(Strategy::ProfitGreedy),
            _ => None,
        }
    }
}

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
    let mut cfg = raw
        .validate()
        .map_err(|e| format!("config validation: {e:?}"))?;
    // `SHASWAP_MAX_ORDERS_PER_TX` overrides the deployment JSON's cap (handy for
    // tuning/testing without editing the file). Ignored if 0 / unparseable.
    if let Some(n) = std::env::var("SHASWAP_MAX_ORDERS_PER_TX")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
    {
        cfg.max_orders_per_tx = n;
    }
    // Drain strategy: env override, else the deployment JSON, else the default.
    // An unrecognized value falls through rather than aborting startup.
    let strategy = std::env::var("SHASWAP_STRATEGY")
        .ok()
        .as_deref()
        .and_then(Strategy::parse)
        .or_else(|| Strategy::parse(&raw.strategy))
        .unwrap_or_default();

    let backend = KupoOgmios::new(cfg.clone()).map_err(|e| format!("backend: {e:?}"))?;
    // Preflight: refuse to run against a Kupo indexing a DIFFERENT deployment (a stale
    // index after a redeploy would silently yield zero pools). Fails fast with a hint.
    backend
        .preflight_deployment(&raw.settlement_hash)
        .map_err(|e| format!("kupo preflight: {e:?}"))?;
    let skey = assemble::load_signing_key(&signing_key_path).map_err(|e| format!("skey: {e:?}"))?;
    let solver_addr = solver_address(network_id, &skey)?;
    let submit = std::env::var("SHASWAP_SUBMIT").as_deref() == Ok("1");
    // Daemon poll cadence (ms): `SHASWAP_INTERVAL_MS` preferred; `SHASWAP_INTERVAL_SECS`
    // (×1000) kept for back-compat. Either > 0 → daemon mode; else one-shot. The poll
    // is a cheap Kupo `/checkpoints` GET, and we settle only when the checkpoint
    // advances — so polling fast is safe (never reads ahead of what Kupo indexed) and
    // makes the batcher reactive by default. The real latency floor is Kupo's index
    // lag, not this cadence, so there's no benefit to an Ogmios push beyond polling
    // briskly here.
    let poll_ms = std::env::var("SHASWAP_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| {
            std::env::var("SHASWAP_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .map(|s| s.saturating_mul(1000))
        })
        .filter(|n| *n > 0);
    let net_label = network_label(network_id, raw.network_magic);
    info!(
        network = %net_label,
        network_magic = raw.network_magic,
        solver = %solver_addr,
        submit,
        mode = %poll_ms.map_or("one-shot".into(), |n| format!("loop {n}ms")),
        strategy = ?strategy,
        cap = cfg.max_orders_per_tx,
        "starting"
    );
    // Loud, unmissable guard before any live mainnet submission — settlements move real
    // funds and the contracts are immutable. An operator who started a preprod-built binary
    // against a mainnet deployment (or vice versa) sees it here before the first pass.
    if submit && network_id == 1 {
        warn!(
            network = %net_label,
            "SUBMITTING LIVE ON MAINNET — settlements will spend real funds"
        );
    }

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
    let Some(poll) = poll_ms else {
        return settle_once(
            &backend,
            &cfg,
            &skey,
            &solver_addr,
            ref_bytes,
            submit,
            strategy,
            &mut state,
        );
    };

    // Graceful shutdown: SIGTERM (systemd stop) / SIGINT (Ctrl-C) flip this flag.
    // We check it only BETWEEN passes, so a signal never interrupts a pass mid
    // tx-build/submit (which could leave ambiguous chain state) — the current pass
    // finishes, then we exit cleanly.
    let term = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(sig, term.clone())
            .map_err(|e| format!("install signal handler: {e}"))?;
    }

    // Daemon: **block-driven**. Do a pass when Kupo's checkpoint advances (which
    // also guarantees Kupo has the block's data — no read-stale-data race against
    // the node tip); otherwise just cheaply re-poll. A transient failure logs and
    // waits for the next block rather than killing the daemon.
    let mut last_block: Option<u64> = None;
    while !term.load(Ordering::Relaxed) {
        match backend.kupo_checkpoint() {
            Ok(cp) if last_block != Some(cp) => {
                if let Err(e) = settle_once(
                    &backend,
                    &cfg,
                    &skey,
                    &solver_addr,
                    ref_bytes,
                    submit,
                    strategy,
                    &mut state,
                ) {
                    warn!("pass failed (will retry next block): {e}");
                }
                last_block = Some(cp);
            }
            Ok(_) => {} // no new block since last pass
            Err(e) => warn!("checkpoint poll failed (will retry): {e:?}"),
        }
        sleep_responsive(poll, &term);
    }
    info!("received shutdown signal; exiting cleanly");
    Ok(())
}

/// Sleep up to `total_ms`, but wake early (in ≤250 ms steps) if `term` is set, so
/// shutdown stays responsive even when the poll cadence is large.
fn sleep_responsive(total_ms: u64, term: &AtomicBool) {
    let mut left = total_ms;
    while left > 0 && !term.load(Ordering::Relaxed) {
        let step = left.min(250);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;
    }
}

/// Loop-carried state across passes.
///
/// `pending` maps every input UTXO we've spent in a submitted-but-unconfirmed tx
/// (settled order refs AND the wallet funding UTXO) to the slot we submitted it at.
/// A pending order is excluded from settlement and a pending wallet UTXO from
/// funding selection — so a chain in flight is never double-spent before it
/// confirms. Entries expire after [`PENDING_GRACE_SLOTS`] (the tx failed → retry)
/// or simply linger harmlessly once the UTXO confirms-spent (it leaves the chain
/// snapshot, so it can't be re-selected regardless). Collateral is intentionally
/// NOT tracked here — a phase-2-passing tx never consumes it, so it is reused.
#[derive(Default)]
struct LoopState {
    pending: HashMap<Key, u64>,
    cursor: usize,
    /// Total solver-wallet ADA at the first pass — the baseline for the running
    /// P&L readout (a confirmed settlement moves the solver's ADA by exactly
    /// tips − fee, so the wallet balance's drift since start is realized profit).
    start_balance: Option<i128>,
}

impl LoopState {
    /// Drop pending entries whose grace window has elapsed (relative to the current
    /// tip slot), freeing their inputs to be retried if the tx never confirmed.
    fn expire_pending(&mut self, tip_slot: u64) {
        self.pending
            .retain(|_, &mut submitted| tip_slot.saturating_sub(submitted) <= PENDING_GRACE_SLOTS);
    }
}

/// How a pool's drain attempt ended — distinguishes a recoverable skip from a
/// pass-fatal submit failure.
enum PassError {
    /// Non-fatal: solve/assemble failed for this pool and NOTHING was submitted, so
    /// the rolling funding is untouched — skip this pool, keep draining the others.
    SkipPool(Err),
    /// Fatal to the pass: a submit failed, so the rolling funding is now ambiguous
    /// (the tx may or may not be in the mempool). Stop the pass immediately rather
    /// than build a later link on a maybe-spent UTXO; the next pass re-discovers
    /// real chain state, and `pending` + the grace window handle recovery.
    AbortPass(Err),
}

/// One discover → group-by-pool → drain-the-chain pass.
#[allow(clippy::too_many_arguments)]
fn settle_once(
    backend: &KupoOgmios,
    cfg: &ValidatedConfig,
    skey: &SecretKey,
    solver_addr: &str,
    ref_bytes: u64,
    submit: bool,
    strategy: Strategy,
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

    // Expire stale pending entries (failed/never-confirmed txs → retry), then
    // exclude still-pending orders so an in-flight chain is never double-spent.
    state.expire_pending(tip.slot);
    let orders: Vec<OrderInput> = all_orders
        .into_iter()
        .filter(|o| !state.pending.contains_key(&key(&o.output_reference)))
        .collect();

    // Running P&L readout: total confirmed wallet ADA + its drift since the first
    // pass. Settlements move the solver's ADA only by tips − fee (owner/pool
    // outputs go elsewhere) and collateral is constant, so `delta` is realized
    // profit. It lags by any in-flight (unconfirmed) settlements and would also
    // move if the address were funded/swept out of band — so it's the wallet
    // balance trend, not a strict ledger of every tx.
    let balance: i128 = wallet.iter().map(|u| u.value.lovelace_of()).sum();
    let start = *state.start_balance.get_or_insert(balance);
    info!(
        slot = tip.slot,
        pools = pools.len(),
        orders = orders.len(),
        pending = state.pending.len(),
        wallet = wallet.len(),
        balance_ada = balance,
        delta_ada = balance - start,
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
    // Σ posted tips per pool — the profit-greedy ordering key (a proxy for the
    // tip the solver would take; exact for v1 full fills). Cheap to compute here.
    let tips_by_nft: HashMap<NftKey, i128> = by_pool
        .iter()
        .map(|(k, ords)| (k.clone(), ords.iter().map(|o| o.datum.tip).sum()))
        .collect();

    // Decide which pools to attempt and in what order (per the chosen strategy),
    // and which orders are orphans (target a pool we don't see).
    let (attempt, orphans) = settlement_plan(
        &pool_nfts,
        &order_nfts,
        state.cursor,
        strategy,
        &tips_by_nft,
    );
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

    // Build a CHAIN of settlement txs in one pass, each funded by the previous
    // tx's change output and submitted back-to-back into the mempool (which
    // accepts chained txs). Every settleable pool contributes ≥1 tx; a pool with
    // more than `max_orders_per_tx` settleable orders is itself drained over
    // several chained txs (k capped batches). This drains the whole orderbook in
    // one pass instead of one pool per block. The chain's funding starts at the
    // solver's on-chain funding UTXO; the collateral is shared across the chain
    // (a phase-2-passing tx never consumes its collateral — the EvaluateTx gate
    // guarantees phase-2 success — so it stays in the mempool UTXO set for every
    // link; see MEMORY). Funding UTXOs already spent by an unconfirmed prior pass
    // are excluded so we never re-spend them before they confirm.
    let Ok((funding0, collateral0)) = select_inputs(&wallet, &state.pending) else {
        // No spendable funding distinct from collateral — either everything is
        // pending an earlier pass's confirmation, or the wallet is underfunded.
        // Wait it out (the daemon retries next block); don't treat it as fatal.
        debug!("no spendable funding this pass (pending confirmation or underfunded)");
        return Ok(());
    };
    let funding0_key = key(&funding0.output_reference);
    let mut chain = ChainCtx {
        funding: (funding0.output_reference.clone(), funding0.value.clone()),
        collateral: collateral0.output_reference.clone(),
        resolved: Vec::new(),
    };

    let mut settled = 0usize;
    for pi in attempt {
        let pool = &pools[pi];
        let ords = &by_pool[&pool_nfts[pi]];
        match settle_pool(
            backend,
            cfg,
            skey,
            solver_addr,
            ref_bytes,
            &params,
            pool,
            ords,
            submit,
            tip.slot,
            &mut chain,
            &mut state.pending,
        ) {
            Ok(n) => settled += n,
            Err(PassError::SkipPool(e)) => {
                // Nothing was submitted for this pool; the rolling funding is
                // untouched, so the next pool safely retries from the same UTXO.
                warn!(
                    nft = hex::encode(&pool.datum.nft.policy),
                    "settle skipped: {e}"
                );
                continue;
            }
            Err(PassError::AbortPass(e)) => {
                // A submit failed: the rolling funding is now ambiguous (the tx may
                // be in the mempool). Stop the pass; next pass re-discovers state.
                warn!(
                    nft = hex::encode(&pool.datum.nft.policy),
                    "submit failed, aborting pass: {e}"
                );
                break;
            }
        }
    }
    // If we submitted anything, the first link consumed the wallet funding UTXO —
    // mark it pending so a follow-up pass can't re-spend it before it confirms.
    if submit && settled > 0 {
        state.pending.insert(funding0_key, tip.slot);
    }
    // Rotate the lead pool each pass so a persistently-unsolvable pool can't pin
    // the chain order (round-robin fairness, retained from the one-per-block era).
    state.cursor = state.cursor.wrapping_add(1);
    if settled == 0 {
        debug!("no pool produced a settlement this pass");
    } else {
        info!(settled, "chained settlement txs this pass");
    }
    Ok(())
}

/// Rolling state for a chain of settlement txs built within one pass. `funding`
/// starts at the solver's on-chain funding UTXO and advances to each tx's change
/// output; `collateral` is shared across the chain; `resolved` accumulates every
/// in-flight output (change AND pool-continuation) to supply as `additionalUtxo`
/// so each tx's `EvaluateTx` can resolve its not-yet-confirmed ancestors.
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
/// pools that have at least one settleable order, ordered per `strategy`:
/// - [`Strategy::RoundRobin`] — sorted by NFT then rotated by `cursor`, so no pool
///   is starved across passes;
/// - [`Strategy::ProfitGreedy`] — highest `tips_by_nft` first (NFT tie-break), so
///   the most valuable pools clear soonest (`cursor` unused).
///
/// `orphans` is the order NFTs that match no known pool (deduped, sorted; logged,
/// never settled). Ordering is the only thing a strategy controls — every pool with
/// a settleable batch is still attempted; what actually settles is the per-pool
/// solve + fee-cover gate, independent of strategy.
fn settlement_plan(
    pool_nfts: &[NftKey],
    order_nfts: &[NftKey],
    cursor: usize,
    strategy: Strategy,
    tips_by_nft: &HashMap<NftKey, i128>,
) -> (Vec<usize>, Vec<NftKey>) {
    let have: HashSet<&NftKey> = order_nfts.iter().collect();
    let mut attempt: Vec<usize> = (0..pool_nfts.len())
        .filter(|&i| have.contains(&pool_nfts[i]))
        .collect();
    match strategy {
        Strategy::RoundRobin => {
            attempt.sort_by(|&a, &b| pool_nfts[a].cmp(&pool_nfts[b]));
            let len = attempt.len();
            if len > 0 {
                attempt.rotate_left(cursor % len);
            }
        }
        Strategy::ProfitGreedy => {
            // Highest Σtips first; NFT tie-break keeps it deterministic.
            let tips = |n: &NftKey| tips_by_nft.get(n).copied().unwrap_or(0);
            attempt.sort_by(|&a, &b| {
                tips(&pool_nfts[b])
                    .cmp(&tips(&pool_nfts[a]))
                    .then_with(|| pool_nfts[a].cmp(&pool_nfts[b]))
            });
        }
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

/// Drain ONE pool into the tx chain, splitting its orders into capped batches
/// (`cfg.max_orders_per_tx`): each batch is re-solved against the previous batch's
/// pool-continuation output (the pool reserves move per batch, so a re-solve is
/// required, not optional), assembled, gated, and (when enabled) submitted, then
/// the chain advances (its change funds the next tx; its change + pool output are
/// supplied as `additionalUtxo` ancestors to the next gate). On submit, the
/// settled order refs are recorded in `pending` (keyed by submit slot). Returns
/// the number of settlement txs produced, or a [`PassError`] distinguishing a
/// recoverable skip (nothing submitted) from a pass-fatal submit failure.
#[allow(clippy::too_many_arguments)]
fn settle_pool(
    backend: &KupoOgmios,
    cfg: &ValidatedConfig,
    skey: &SecretKey,
    solver_addr: &str,
    ref_bytes: u64,
    params: &chain::backend::ProtocolParams,
    pool: &PoolInput,
    orders: &[OrderInput],
    submit: bool,
    submit_slot: u64,
    chain: &mut ChainCtx,
    pending: &mut HashMap<Key, u64>,
) -> Result<usize, PassError> {
    let nft = hex::encode(&pool.datum.nft.policy);
    // Orders not yet placed in a batch, and the rolling pool state (the on-chain
    // pool for batch 1, then each batch's pool-continuation output).
    let mut remaining: Vec<OrderInput> = orders.to_vec();
    let mut pool_input: PoolInput = pool.clone();
    let mut batches = 0usize;

    loop {
        let Some(solved) =
            solver_core::solve::solve_capped(&remaining, &pool_input, cfg.max_orders_per_tx)
        else {
            if batches == 0 {
                debug!(nft, orders = remaining.len(), "no valid clearing");
            }
            break;
        };
        info!(
            nft,
            batch = batches + 1,
            price = format!("{}/{}", solved.price.num, solved.price.den),
            included = format!("{}/{}", solved.orders.len(), remaining.len()),
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
        // Fund this link from the rolling chain funding; spend the rolling pool.
        let funding_pairs: Vec<(_, Value)> = vec![chain.funding.clone()];
        let inp = AssembleInputs {
            settlement: &solved.settlement,
            orders: &solved.orders,
            pool: &pool_input,
            funding: &funding_pairs,
            collateral: &chain.collateral,
            solver_addr_bech32: solver_addr,
            config: cfg,
            params,
            ref_script_total_bytes: ref_bytes,
            invalid_after_slot,
        };
        // Resolve this tx's not-yet-confirmed ancestors (funding + rolled pool).
        // A build/gate failure submits nothing, so the chain is untouched → skip.
        let built = assemble::build_signed(&inp, backend, skey, &chain.resolved)
            .map_err(|e| PassError::SkipPool(format!("assemble: {e:?}").into()))?;

        // Economically rational: don't burn ADA on a batch whose tips don't cover
        // its fee. Stop draining this pool here (the remaining orders defer to a
        // later, better-amortized batch) rather than advancing the chain.
        if solved.settlement.tip_taken_total < built.fee as i128 + FEE_COVER_MARGIN as i128 {
            info!(
                nft,
                tip_take = solved.settlement.tip_taken_total,
                fee = built.fee,
                "skip: tips do not cover fee (+margin); deferring remaining orders"
            );
            break;
        }
        info!(
            nft,
            batch = batches + 1,
            tx = hex::encode(built.signed.tx_hash.0),
            fee = built.fee,
            mem = built.total_ex_units.mem,
            steps = built.total_ex_units.steps,
            "built + evaluated OK (gate passed)"
        );

        if submit {
            // A submit failure is pass-fatal: the tx may already be in the mempool
            // (spending this link's funding), so no later link may reuse it.
            let txid = backend
                .submit(&built.signed.tx_bytes.0)
                .map_err(|e| PassError::AbortPass(format!("submit: {e:?}").into()))?;
            for o in &solved.orders {
                pending.insert(key(&o.output_reference), submit_slot);
            }
            info!(nft, tx = hex::encode(&txid), "SUBMITTED");
        } else {
            info!(
                nft,
                bytes = built.signed.tx_bytes.0.len(),
                "dry run (set SHASWAP_SUBMIT=1 to submit)"
            );
        }

        // Advance the chain. The change funds the next tx and the pool-continuation
        // output becomes the next batch's pool input (re-solved against its new
        // reserves); both are kept as the ONLY `additionalUtxo` ancestors for the
        // next gate — older outputs were consumed by intervening links and are never
        // referenced again, so pruning to just these keeps the set O(1). Done in
        // dry-run too, so a full chain is built + gated without submitting.
        chain.funding = (
            built.change.output_reference.clone(),
            built.change.value.clone(),
        );
        pool_input = built.next_pool;
        chain.resolved = vec![built.change, built.pool_out];
        batches += 1;

        // Drop the orders just settled; stop when the pool is drained.
        let done: HashSet<Key> = solved
            .orders
            .iter()
            .map(|o| key(&o.output_reference))
            .collect();
        remaining.retain(|o| !done.contains(&key(&o.output_reference)));
        if remaining.is_empty() {
            break;
        }
    }
    Ok(batches)
}

/// Pick the solver's funding + collateral UTXOs. Collateral must be pure-ADA (no
/// datum/tokens/ref-script) and ≥ 5 ADA — which exceeds the worst-case collateral
/// requirement (fee × `collateralPercentage`) for ANY tx on this network, since
/// fee is bounded by the max ex-units + max tx size. Funding is the largest
/// **ada-only** UTXO that isn't a reference script and isn't the collateral.
///
/// Funding requires ada-only (`value.is_ada_only()`) as a **dust/token-poisoning
/// defense**: the solver address is public, so anyone can send it a UTXO; if a
/// token-bearing one were chosen as funding, those foreign tokens would ride into
/// the solver-change output, inflating its min-ADA / size until the settlement
/// can't be built. A datum on an ada-only vkey UTXO is inert (it doesn't propagate
/// to change), so it's still fine to fund from. Because every settlement's change
/// is ada-only, the solver self-funds from its own change indefinitely; gifted
/// tokens simply sit unused. (Pure dust just isn't the largest, so it's ignored;
/// and each dust UTXO costs the attacker min-ADA, so the vector is bounded.)
///
/// `pending` excludes UTXOs already spent by an earlier, still-unconfirmed pass
/// (Kupo only marks an input spent on block confirmation, so a freshly-spent
/// funding UTXO still appears unspent here) — without this guard a second pass
/// firing before the prior chain confirms would re-select and double-spend it.
fn select_inputs<'a>(
    wallet: &'a [Utxo],
    pending: &HashMap<Key, u64>,
) -> Result<(&'a Utxo, &'a Utxo), Err> {
    let usable = |u: &Utxo| !pending.contains_key(&key(&u.output_reference));
    let collateral = wallet
        .iter()
        .filter(|u| {
            u.is_pure_ada() && u.value.lovelace_of() >= COLLATERAL_LOVELACE as i128 && usable(u)
        })
        .min_by_key(|u| u.value.lovelace_of())
        .ok_or("no pure-ADA collateral UTXO >= 5 ADA")?;
    let funding = wallet
        .iter()
        .filter(|u| {
            u.value.is_ada_only()
                && !u.has_reference_script
                && u.output_reference != collateral.output_reference
                && usable(u)
        })
        .max_by_key(|u| u.value.lovelace_of())
        .ok_or("no ada-only funding UTXO (distinct from collateral)")?;
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
    // Startup check: nothing is in flight yet, so no pending exclusions.
    let no_pending = HashMap::new();
    if select_inputs(&wallet, &no_pending).is_ok() {
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
        if select_inputs(&w, &no_pending).is_ok() {
            info!("collateral confirmed; wallet ready");
            return Ok(());
        }
    }
    Err("timed out waiting for the collateral split to confirm".into())
}

/// Human label for the active network, for the startup banner. `network_id == 1` is the
/// Shelley mainnet tag; testnets share id 0 and are told apart by the magic (preprod = 1,
/// preview = 2). An operator must be able to eyeball this before enabling live submission.
fn network_label(network_id: u8, network_magic: u64) -> String {
    match (network_id, network_magic) {
        (1, _) => "MAINNET".to_string(),
        (0, 1) => "preprod".to_string(),
        (0, 2) => "preview".to_string(),
        (id, magic) => format!("testnet(id={id}, magic={magic})"),
    }
}

/// The solver's own enterprise (no-stake) address for a given network, from its signing
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

    #[test]
    fn network_label_distinguishes_mainnet_from_testnets() {
        assert_eq!(network_label(1, 764824073), "MAINNET");
        assert_eq!(network_label(1, 0), "MAINNET"); // id==1 is mainnet regardless of magic
        assert_eq!(network_label(0, 1), "preprod");
        assert_eq!(network_label(0, 2), "preview");
        assert_eq!(network_label(0, 42), "testnet(id=0, magic=42)");
    }

    fn nft(b: u8) -> NftKey {
        (vec![b; 28], b"NFT".to_vec())
    }

    /// Round-robin plan with no profit info (the tip map is unused by RR).
    fn rr(pools: &[NftKey], orders: &[NftKey], cursor: usize) -> (Vec<usize>, Vec<NftKey>) {
        settlement_plan(pools, orders, cursor, Strategy::RoundRobin, &HashMap::new())
    }

    #[test]
    fn plan_picks_only_pools_with_orders() {
        let pools = [nft(1), nft(2), nft(3)];
        // orders for pools 1 and 3 only.
        let orders = [nft(3), nft(1)];
        let (attempt, orphans) = rr(&pools, &orders, 0);
        // sorted by nft -> pool index 0 (nft1), 2 (nft3).
        assert_eq!(attempt, vec![0, 2]);
        assert!(orphans.is_empty());
    }

    #[test]
    fn plan_rotates_by_cursor_for_fairness() {
        let pools = [nft(1), nft(2), nft(3)];
        let orders = [nft(1), nft(2), nft(3)];
        assert_eq!(rr(&pools, &orders, 0).0, vec![0, 1, 2]);
        assert_eq!(rr(&pools, &orders, 1).0, vec![1, 2, 0]);
        assert_eq!(rr(&pools, &orders, 2).0, vec![2, 0, 1]);
        // cursor wraps past the candidate count.
        assert_eq!(rr(&pools, &orders, 3).0, vec![0, 1, 2]);
    }

    #[test]
    fn plan_profit_greedy_orders_by_tips() {
        let pools = [nft(1), nft(2), nft(3)];
        let orders = [nft(1), nft(2), nft(3)];
        // pool 2 richest, then pool 3, then pool 1 — regardless of cursor.
        let tips: HashMap<NftKey, i128> =
            [(nft(1), 1_000), (nft(2), 9_000), (nft(3), 5_000)].into();
        let (attempt, _) = settlement_plan(&pools, &orders, 0, Strategy::ProfitGreedy, &tips);
        assert_eq!(attempt, vec![1, 2, 0]); // indices of pools 2, 3, 1
                                            // equal tips fall back to a deterministic NFT order (no herd nondeterminism).
        let flat: HashMap<NftKey, i128> = [(nft(1), 7), (nft(2), 7), (nft(3), 7)].into();
        let (a2, _) = settlement_plan(&pools, &orders, 2, Strategy::ProfitGreedy, &flat);
        assert_eq!(a2, vec![0, 1, 2]);
    }

    #[test]
    fn plan_strategy_parse_accepts_aliases_and_falls_back() {
        assert_eq!(Strategy::parse("round-robin"), Some(Strategy::RoundRobin));
        assert_eq!(Strategy::parse("RR"), Some(Strategy::RoundRobin));
        assert_eq!(
            Strategy::parse("profit_greedy"),
            Some(Strategy::ProfitGreedy)
        );
        assert_eq!(Strategy::parse("greedy"), Some(Strategy::ProfitGreedy));
        assert_eq!(Strategy::parse("nonsense"), None);
        assert_eq!(Strategy::default(), Strategy::RoundRobin);
    }

    #[test]
    fn plan_reports_orphans_and_skips_them() {
        let pools = [nft(1)];
        // orders for the known pool (1) and two unknown pools (7, 8).
        let orders = [nft(7), nft(1), nft(8), nft(7)];
        let (attempt, orphans) = rr(&pools, &orders, 0);
        assert_eq!(attempt, vec![0]); // only the known pool is attempted
        assert_eq!(orphans, vec![nft(7), nft(8)]); // deduped + sorted, never settled
    }

    #[test]
    fn plan_empty_when_no_orders_match_any_pool() {
        let pools = [nft(1), nft(2)];
        let orders = [nft(9)];
        let (attempt, orphans) = rr(&pools, &orders, 5);
        assert!(attempt.is_empty());
        assert_eq!(orphans, vec![nft(9)]);
    }

    fn utxo(b: u8, lovelace: i128, pure: bool) -> Utxo {
        Utxo {
            output_reference: OutputReference {
                transaction_id: vec![b; 32],
                output_index: 0,
            },
            value: Value::from_lovelace(lovelace),
            has_reference_script: false,
            has_datum: !pure,
        }
    }

    #[test]
    fn expire_pending_drops_only_stale_entries() {
        let mut s = LoopState::default();
        s.pending.insert((vec![1; 32], 0), 100); // submitted at slot 100
        s.pending.insert((vec![2; 32], 0), 100);
        // tip 100 + grace: nothing expires yet.
        s.expire_pending(100 + PENDING_GRACE_SLOTS);
        assert_eq!(s.pending.len(), 2);
        // one slot past the grace window: both expire (failed/unconfirmed → retry).
        s.expire_pending(100 + PENDING_GRACE_SLOTS + 1);
        assert!(s.pending.is_empty());
    }

    #[test]
    fn select_inputs_excludes_pending_funding() {
        // big funding UTXO (#9) + two pure-ADA candidates for collateral (#5,#6).
        let wallet = vec![
            utxo(9, 100_000_000, false),
            utxo(5, COLLATERAL_LOVELACE as i128, true),
            utxo(6, COLLATERAL_LOVELACE as i128 + 1, true),
        ];
        // Nothing pending → the largest non-collateral UTXO funds.
        let none = HashMap::new();
        let (f, _c) = select_inputs(&wallet, &none).unwrap();
        assert_eq!(f.output_reference.transaction_id, vec![9; 32]);

        // Mark #9 pending (spent by an unconfirmed prior pass): it must NOT be
        // re-selected as funding; the next-largest usable UTXO is chosen instead.
        let mut pending = HashMap::new();
        pending.insert((vec![9u8; 32], 0u64), 0u64);
        let (f2, _c2) = select_inputs(&wallet, &pending).unwrap();
        assert_ne!(f2.output_reference.transaction_id, vec![9; 32]);

        // With every spendable UTXO pending, selection fails (wait, don't double-spend).
        for u in &wallet {
            pending.insert(key(&u.output_reference), 0);
        }
        assert!(select_inputs(&wallet, &pending).is_err());
    }

    #[test]
    fn select_inputs_rejects_token_bearing_funding_dust() {
        // Attacker gifts a FAT token-bearing UTXO (largest by ADA) to the solver
        // address, hoping it's chosen as funding so its tokens poison the change.
        let mut poison = utxo(9, 1_000_000_000, true);
        poison.value = poison.value.add(&[0x33; 28], b"JUNK", 1); // now NOT ada-only
                                                                  // a legitimate, smaller ada-only funding UTXO + a pure-ADA collateral.
        let funding = utxo(7, 50_000_000, true);
        let collateral = utxo(5, COLLATERAL_LOVELACE as i128, true);
        let wallet = vec![poison, funding, collateral];

        let none = HashMap::new();
        let (f, _c) = select_inputs(&wallet, &none).unwrap();
        // Funding is the ada-only #7, NOT the bigger token-bearing #9.
        assert_eq!(f.output_reference.transaction_id, vec![7; 32]);

        // If the ONLY non-collateral UTXO is token-bearing, funding selection fails
        // (stall safely) rather than poisoning the change.
        let only_poison = vec![
            {
                let mut u = utxo(9, 1_000_000_000, true);
                u.value = u.value.add(&[0x33; 28], b"JUNK", 1);
                u
            },
            utxo(5, COLLATERAL_LOVELACE as i128, true),
        ];
        assert!(select_inputs(&only_poison, &none).is_err());
    }
}
