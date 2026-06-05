# batcher — ShaSwap reference solver

A standalone Rust **reference solver** for the ShaSwap batch-auction DEX. It is a
**permissionless, unprivileged** role: it watches the chain for order UTXOs + the
pool, computes a uniform-price clearing off-chain, builds a settlement the on-chain
validators accept, and submits it. It has no special authority and earns only the
ADA tips posted on orders — anyone may run their own.

> Source of truth is `../documentation/BLUEPRINT.md` and the contracts in
> `../contracts/`. The contract is the oracle of correctness: the batcher's job is
> "make the validators accept my tx." `solver-core` mirrors
> `contracts/lib/shaswap/clearing.ak` **to the lovelace**.

## Workspace layout

| Crate / path | What | Status |
|---|---|---|
| `crates/solver-core` | Pure clearing arithmetic + v1 solver + sim. No IO. | **implemented** |
| `crates/txbuilder` | Vendored fork of `pallas-txbuilder` 1.0 + **withdrawal/reward-redeemer support** (the withdraw-0 mechanism upstream lacks). | **implemented (fork)** |
| `crates/txbuild` | Lower a `Settlement` into the chain-independent tx skeleton (Plutus Data, addresses, values, canonical outputs, redeemer/withdraw-0 plan). | **implemented (skeleton)** |
| `crates/chain` | `ChainBackend` trait + Kupo/Ogmios HTTP transport (`kupo_ogmios`) + body assembler (`assemble`) + typed fail-fast `Config` + on-chain datum decoder + fee arithmetic. | **implemented** |
| `crates/orchestrator` | Live loop (bin `shaswap-batcher`): discover → solve → assemble → evaluate (gate) → submit, against preprod. | **implemented** |

## Running the solver (`shaswap-batcher`)

Needs a running preprod node with Ogmios (`:1337`) + Kupo (`:1442`) — see
`../contracts/happy_path/run-ogmios.sh` and `run-kupo.sh`. The deployment
identities + signing-key path come from a `deployment.json` (see
`../contracts/happy_path/deployment.json`).

```sh
# one-shot dry run (build + EvaluateTx gate + print; does NOT submit)
SHASWAP_DEPLOYMENT=../contracts/happy_path/deployment.json \
  cargo run -p orchestrator

SHASWAP_SUBMIT=1          # actually submit settlements
SHASWAP_INTERVAL_MS=500   # run as a daemon at this poll cadence (or _SECS; else one-shot)
SHASWAP_MAX_ORDERS_PER_TX=20   # per-tx order cap (overrides deployment JSON)
SHASWAP_STRATEGY=round-robin   # drain order: round-robin | profit-greedy
RUST_LOG=debug            # verbosity (default info); tracing w/ timestamps + levels
```

**Mainnet.** Start from [`config/deployment.mainnet.example.json`](config/deployment.mainnet.example.json)
(`network_id=1`, `network_magic=764824073`, your own Kupo/Ogmios, a `0600` skey). The
startup banner prints `network=MAINNET` and, with `SHASWAP_SUBMIT=1`, logs an explicit
live-funds warning — confirm the network before going live. Full operator runbook
(systemd, monitoring, alerts, recovery, key management):
[`../documentation/launch/batcher-operations.md`](../documentation/launch/batcher-operations.md).

```sh
SHASWAP_DEPLOYMENT=../contracts/happy_path/deployment.json \
SHASWAP_SUBMIT=1 \
SHASWAP_INTERVAL_MS=500 \
SHASWAP_MAX_ORDERS_PER_TX=20 \
SHASWAP_STRATEGY=round-robin \
RUST_LOG=info \
./target/release/shaswap-batcher
```

**Daemon / systemd.** The poll is a cheap Kupo-checkpoint GET, so a small interval
(e.g. 500 ms) keeps it reactive without reading ahead of what Kupo has indexed (the
latency floor is Kupo's index lag, not the cadence). `SIGTERM`/`SIGINT` shut it down
cleanly **between passes** — a signal never interrupts a pass mid-submit — so it's
safe under `systemd`. Each pass logs a running wallet-balance P&L (`balance_ada` +
`delta_ada` since start). Every built tx is `isValid == true` and gated by
`EvaluateTx` before submit, so the node accepts it and the collateral is never
consumed. Funding is drawn only from ada-only UTXOs (a dust/token-poisoning guard).

**Zero-config and self-maintaining.** Deploy, send some ADA to the solver address,
and run — the batcher discovers everything itself:

- **Any number of pools / pairs, drained per pass via tx chaining.** It finds every
  pool at the pool address (each self-describes its pair + NFT via its `PoolDatum`;
  no per-pool config), groups orders by their target pool, and settles each pool's
  batch at its own uniform price. A settlement tx settles one pool, so a pass builds
  a **chain** of settlement txs — one per settleable pool — each funded by the
  previous tx's change output, gated, and submitted back-to-back into the mempool
  (which accepts chained txs). The previous tx's still-unconfirmed change is supplied
  to each `EvaluateTx` gate via Ogmios `additionalUtxo` (it isn't on-chain yet); the
  collateral is **shared** across the chain (a phase-2-passing tx never consumes it).
  This drains the whole settleable orderbook in one pass instead of one pool per
  block. One-sided and two-sided (netting) batches.
- **Capped batches per tx.** `max_orders_per_tx` (deployment JSON, default 20;
  override with `SHASWAP_MAX_ORDERS_PER_TX`) bounds orders per settlement tx. A pool
  with more settleable orders is drained over **k chained txs**, each re-solved
  against the previous batch's pool-continuation output. Raising it packs more orders
  per tx; a value whose batch exceeds the per-tx ex-unit/size budget makes that tx
  fail and the pool be skipped until orders drop — so 20 is conservative.
- **Economically rational.** A tx whose tips don't cover its fee (+`FEE_COVER_MARGIN`)
  is skipped; its orders defer to a later, better-amortized batch.
- **Pluggable drain ordering.** `strategy` (deployment JSON, default `round-robin`;
  override with `SHASWAP_STRATEGY`) sets the order pools/shards are attempted in:
  `round-robin` (fair, starvation-free) or `profit-greedy` (highest Σtips first).
  It only affects *ordering* (and, across competing solvers, who wins what and how
  fast) — never which orders are batchable (that's the floor + fee-cover gate).
- **Atomic discovery** — one Kupo snapshot per pass; the order/pool/wallet views
  can't drift mid-pass.
- **Griefing-resistant** — skips (never aborts on) junk UTXOs parked at the public
  order address.
- **Self-provisioning collateral** — on first run, if the wallet is a single lump,
  it carves a dedicated 5-ADA collateral UTXO; thereafter the wallet self-maintains
  (settlements regenerate the funding-change UTXO; collateral is never spent on
  success).
- **Block-driven loop** — `SHASWAP_INTERVAL_SECS` is the Kupo-checkpoint poll
  cadence; a settle pass runs only when a new block is indexed (no wasted work
  between blocks; never reads ahead of Kupo). Just-submitted orders are tracked
  in-flight so it never double-spends before they confirm.

## `solver-core` (done)

Deterministic, IO-free, unit/property tested in isolation:

- **`value`** — Cardano multi-asset `Value` with normalized equality (matches
  `aiken/cardano/assets`), so output pins compare exactly.
- **`types` / `output`** — datum/redeemer + ledger output shapes mirrored from
  `types.ak`; constants mirror `constants.ak` (drift = rejected settlements).
- **`curve`** — `reserve_of` + the `k`-with-fee invariant (exact `BigInt`, mirrors
  `spend.pool_settle`) + a forward Uniswap-v2 swap to route the pool residual.
- **`clearing`** — the settlement **pin generator**: a line-for-line port of
  `clearing.ak`'s `run`/`process`/`check_one`. `build_settlement(...)` returns the
  exact owner/pool/remainder outputs the anchor accepts, or the same error its
  `expect`s would fail on. This is what `txbuild` will lower.
- **`solve`** — the v1 **floor-only** clearing algorithm (a *valid*, not optimal,
  solver): pick a uniform price (the supply/demand balance / CoW price, with the
  pool spot and per-order floors as fallbacks), include floor-satisfying orders,
  net opposing orders, route the residual through the pool so `k`-with-fee holds.
  **Every returned settlement is re-verified** against the pin generator and the
  `k`-check — it can under-solve, but never emits a settlement the chain rejects.
  When the per-tx cap truncates a **netted** book, the kept subset is re-priced at
  *its own* balance price (and the two sides are interleaved so the subset stays
  balanced) — otherwise reusing the full-book price leaves a residual the pool
  rejects, and a netted book larger than the cap would fail to settle at all.
- **`sim`** — synthetic order-book harness; the economic measurement (no chain).

### Tests

- **Golden** (`tests/golden.rs`) — mirror the `clearing_test.ak` fixtures and assert
  the generated outputs match the contract's accepted values exactly (happy n1/n3,
  partial token-seller, perfect netting, ADA-seller solo, token/token, incidental
  pass-through) plus the rejection paths (floor breach, wrong pool, partial-not-
  allowed, deadline, non-positive price).
- **Property** (`tests/property.rs`) — over 5 000 random single-order settlements
  (both directions, full + partial): **conservation + no-skim** —
  `Σ inputs == Σ outputs + solver tip take`, and the solver's take is exactly the
  proportional tip. A leak in any per-role delta would unbalance it.

```sh
cargo test                                   # all crates
cargo clippy --all-targets -- -D warnings    # lint gate
cargo run -p solver-core --example sim_sweep # netting/surplus numbers
```

### Sim result (netting vs batch size)

`cargo run -p solver-core --example sim_sweep` on balanced two-sided books — netting
rises with batch size as more flow clears user-to-user instead of through the pool:

```
    N   included   netting    surplus_a   solved
    1        1.0      0.0%      -138609    16/16
    5        5.0     66.6%      -187591    16/16
   20       20.0     75.9%      -532494    16/16
   44       44.0     85.4%      -584241    16/16
```

`surplus_a` (vs each order swapping solo against the pool) is negative on one-sided/
imbalanced books because the count-maximizing v1 routes the whole residual through
the pool at a boundary price — concentrating price impact. The economic win is the
*netting* itself; surplus-maximizing price/inclusion is the deferred optimal layer.

## `txbuild` (skeleton done)

The chain-independent half of building a settlement tx — fully unit-tested offline:

- **`plutus`** — Plutus `Data` encoding of every datum/redeemer, matching
  `plutus.json` constructor indices + field order exactly (byte-verified CBOR +
  round-trip).
- **`address`** — solver `Address`/`Credential` → raw Cardano address bytes; the
  reward account for the settlement stake credential `S`.
- **`value`** — solver `Value` → Conway `Value` (coin + canonical multiasset).
- **`plan`** — `plan(settlement, orders, pool, network, S)` → the canonical output
  list (owners `[0,N)`, pool, remainders), the script spends (`Settle`/`PoolSettle`),
  the withdraw-0 account + `SettlementRedeemer`, and the POSIX validity bound;
  `compute_redeemers(...)` assigns `Spend`/`Reward` indices against the **final,
  canonically-sorted** input/withdrawal sets (so it composes with the funding inputs
  the chain layer adds).

> Note: `pallas-txbuilder` 1.0 can't build a ShaSwap settlement — it has no
> withdrawals/reward-redeemer support, which is exactly the anchor's withdraw-0
> mechanism (upstream hard-codes `withdrawals: None`). We **vendored and forked it**
> into `crates/txbuilder` (`shaswap-txbuilder`) and added that support:
> `.withdrawal()`, `.add_withdraw_redeemer()`, `RedeemerPurpose::Reward`, the body
> withdrawals map, and the `Reward` redeemer arm (index = the account's position in
> the canonical withdrawals order). A round-trip test builds a withdraw-0 + reward
> redeemer and re-decodes it to confirm both land. The chain layer drives this
> builder to assemble the final body.

## `chain` (foundations done)

Node-independent, fully tested:

- **`backend`** — the `ChainBackend` trait (tip, params, `find_orders`/`find_pool`,
  the `evaluate` pre-submit gate, `submit`) + its data types. One swappable seam for
  the provider (Kupo+Ogmios now, a local node later).
- **`config`** — typed, fail-fast `Config`; `validate()` rejects malformed hex AND any
  protocol constant that drifts from `constants.ak` (binds the pool NFT, parses ref
  scripts).
- **`decode`** — on-chain Plutus `Data` → `solver-core` datums, the inverse of
  `txbuild::plutus`, **round-trip tested** against the encoder so they can't diverge.
- **`fees`** — the pure body-finalization arithmetic: script-execution fee from
  ex-units + prices, size fee, ex-unit summation, POSIX→slot.

## Status

The full pipeline works live on preprod: the Kupo/Ogmios `ChainBackend`
(discovery, params, the EvaluateTx pre-submit gate with `additionalUtxo`, submit),
the body assembler (funding/collateral, reference inputs, `script_data_hash` over
the cost models, ex-units from EvaluateTx, fee balancing, signing, and emitting the
change output's resolved form for the next link), and the orchestrator loop have
all settled real one-sided, netting, AND **chained multi-pool** batches — a chain
of settlement txs in one pass, sharing one collateral (see `../MEMORY.md`).

Possible follow-ups: within-pool multi-tx splitting when a single pool has more
orders than fit one tx's ex-unit/size budget; surplus-maximizing solving (the
deferred §5.2.7 layer); and the emulator pass still owed on the contracts side.

## Invariants this component must keep

The batcher stays **unprivileged**: no capability the protocol doesn't grant every
solver. Solver reward is ADA tips only. It mirrors the on-chain constants exactly; the
typed `Config` in `chain` loads deployment constants and fails fast if any drifts from
`constants.ak`.
