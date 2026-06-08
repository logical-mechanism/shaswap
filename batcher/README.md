# batcher — ShaSwap reference solver

A standalone Rust **reference solver** for the ShaSwap batch-auction DEX. It is a
**permissionless, unprivileged** role: it watches the chain for order UTXOs and the
pool, computes a uniform-price clearing off-chain, builds a settlement the on-chain
validators accept, and submits it. It has no special authority and earns only the ADA
tips posted on orders — anyone may run their own.

> The contract is the oracle of correctness; the batcher's only job is "make the
> validators accept my tx." `solver-core` mirrors `contracts/lib/shaswap/clearing.ak`
> to the lovelace and fails fast if any on-chain constant drifts. Design source of
> truth: [`../documentation/BLUEPRINT.md`](../documentation/BLUEPRINT.md).

## Workspace

| Crate | What |
|---|---|
| `crates/solver-core` | Clearing arithmetic, the v1 solver, and a sim harness. Pure, no IO. |
| `crates/txbuild` | Lowers a `Settlement` into a chain-independent tx skeleton (Plutus data, addresses, values, canonical outputs, withdraw-0 plan). |
| `crates/txbuilder` | Vendored fork of `pallas-txbuilder` 1.0 with withdrawal / reward-redeemer support (the withdraw-0 mechanism upstream lacks). |
| `crates/chain` | `ChainBackend` trait + Kupo/Ogmios transport, the body assembler, a typed fail-fast `Config`, the datum decoder, and fee arithmetic. |
| `crates/orchestrator` | The live loop (bin `shaswap-batcher`): discover → solve → assemble → evaluate → submit. |

## Running it (`shaswap-batcher`)

Needs a Cardano node with **Ogmios** and **Kupo** (see
`../contracts/happy_path/run-ogmios.sh` / `run-kupo.sh`). Copy a deployment config and
fill in your node URLs and a `0600` signing key:

- **Preprod:** [`config/deployment.preprod.example.json`](config/deployment.preprod.example.json) —
  pinned to the live deployment; set only your Kupo/Ogmios URLs + key.
- **Mainnet:** [`config/deployment.mainnet.example.json`](config/deployment.mainnet.example.json) —
  the startup banner prints `network=MAINNET` and logs a live-funds warning with
  `SHASWAP_SUBMIT=1`. Operator runbook (systemd, monitoring, recovery, key management):
  [`../documentation/launch/batcher-operations.md`](../documentation/launch/batcher-operations.md).

```sh
# dry run: build + EvaluateTx gate + print, no submit
SHASWAP_DEPLOYMENT=path/to/deployment.json cargo run -p orchestrator
```

Common settings (env vars override the deployment JSON):

| Var | Effect |
|---|---|
| `SHASWAP_SUBMIT=1` | actually submit settlements (otherwise dry-run) |
| `SHASWAP_INTERVAL_MS` / `_SECS` | run as a daemon at this poll cadence (else one-shot) |
| `SHASWAP_MAX_ORDERS_PER_TX` | per-tx order cap (default 20) |
| `SHASWAP_STRATEGY` | drain order: `round-robin` (default) or `profit-greedy` |
| `SHASWAP_METRICS_ADDR` | serve Prometheus `/metrics` (+ `/health`, `/ready`) on this `host:port` (off by default) |
| `SHASWAP_HEALTH_ADDR` | serve `/health`, `/ready` (+ `/metrics`) on this `host:port` (off by default) |
| `RUST_LOG` | log verbosity (default `info`) |

When `SHASWAP_METRICS_ADDR` / `SHASWAP_HEALTH_ADDR` are set, a tiny std-only HTTP server
exposes `GET /metrics` (Prometheus text), `GET /health` (liveness), and `GET /ready`
(`503` until a settle pass has run recently — catches a *hung*, not just crashed,
daemon). Both vars may point at the same address. See the operations runbook for the
metric list and alert rules.

## How it behaves

- **Drains every pool each pass via tx chaining.** It finds every pool at the pool
  address (each self-describes its pair + NFT), groups orders by pool, and settles each
  at its own uniform price — one settlement tx per pool, chained back-to-back into the
  mempool (each funded by the previous tx's change, sharing one collateral). Handles
  one-sided and netted (two-sided) batches.
- **Capped batches.** `max_orders_per_tx` bounds orders per tx; a busier pool drains
  over several chained txs. A batch that would exceed the per-tx ex-unit/size budget is
  skipped until orders drop, so the default (20) is conservative.
- **Economically rational.** A tx whose tips don't cover its fee (plus a margin) is
  skipped; its orders wait for a better-amortized batch.
- **Safe to run.** Every tx is `EvaluateTx`-gated before submit, so the node accepts it
  and collateral is never consumed. Funding comes only from ada-only UTXOs. Junk UTXOs
  at the public order address are skipped, never fatal. `SIGTERM`/`SIGINT` stop it
  cleanly between passes. On first run it carves a dedicated ~5-ADA collateral UTXO,
  then self-maintains.
- **Block-driven.** The poll is a cheap Kupo-checkpoint check; a settle pass runs only
  when a new block is indexed. Just-submitted orders are tracked in-flight so it never
  double-spends before they confirm.

The v1 solver is **valid, not optimal**: it picks a uniform price, includes
floor-satisfying orders, nets opposing ones, and routes the residual through the pool so
the `k`-with-fee invariant holds. Every settlement it emits is re-verified against the
same pin generator the chain uses — it can under-solve, but never emits a tx the chain
rejects. Surplus-maximizing pricing is out of scope for v1.

## Build · test

```sh
cargo build
cargo test                                   # all crates
cargo clippy --all-targets -- -D warnings
cargo fmt
cargo run -p solver-core --example sim_sweep # netting / surplus numbers
```

## Invariants this component must keep

The batcher stays **unprivileged** — no capability the protocol doesn't grant every
solver. Solver reward is ADA tips only. It mirrors the on-chain constants exactly: the
typed `Config` loads them and fails fast if any drifts from `constants.ak`.
