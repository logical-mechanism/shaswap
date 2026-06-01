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
| `crates/chain` (planned) | `ChainBackend` trait + Kupo/Ogmios impls (discovery, params, submit, **EvaluateTx** gate). | next |
| `crates/txbuild` (planned) | Lower a `Settlement` into a signed Pallas tx (canonical order, withdraw-0, refs). | next |
| `crates/orchestrator` (planned) | Live loop: discover → solve → build → evaluate → submit (preprod). | later |

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

## Not yet here (next milestones)

1. **`txbuild` + CBOR**: lower `Settlement` into a Pallas tx — owner outputs first
   in canonical input order with `BoundDatum`, pool/remainders tagged `S`, withdraw-0
   for `S` with the `SettlementRedeemer`, order inputs `Settle`, pool input
   `PoolSettle`, `mint == 0`, validity upper bound for deadlines. Needs CBOR
   (de)serialization matching `plutus.json` schemas.
2. **`chain`**: Kupo (UTXO discovery by stake-cred `S` / pool NFT), Ogmios (tip,
   protocol params, submit, and **EvaluateTx as a pre-submit gate** — every built tx
   must pass local Phase-2 evaluation before it touches the network).
3. **Bootstrap dependency** (blocks live preprod settlement): deploy reference
   scripts, register `S` and **never delegate it**, create + seed a pool. See
   `../contracts/happy_path/`.

## Invariants this component must keep

The batcher stays **unprivileged**: no capability the protocol doesn't grant every
solver. Solver reward is ADA tips only. It mirrors the on-chain constants exactly; a
typed `Config` (planned, in `chain`) loads deployment constants and fails fast if any
drifts from `constants.ak`.
