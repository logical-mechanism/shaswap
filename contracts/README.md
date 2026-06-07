# ShaSwap — contracts

On-chain Aiken (Plutus v3) validators for **ShaSwap**, a fully-decentralized,
non-custodial, MEV-resistant **batch-auction DEX on Cardano**. Untrusted solvers
compute uniform-price clearings off-chain; these validators only *verify* them.

> **Design source of truth:** [`../documentation/BLUEPRINT.md`](../documentation/BLUEPRINT.md).
> Read it before changing anything here, and keep code and blueprint in sync (bump the
> blueprint `Revision:` in the same change). The section references below (§5.2, §5.4,
> §6, §7) point into that document.

## What these contracts do

A **settlement** spends one pool UTXO plus a batch of order UTXOs and pays each filled
order its uniquely-bound output, leaving the residual to the pool — all in one
transaction. The batch-wide rules are checked **once per tx** by a withdraw-0 staking
validator (the trust anchor); the order and pool validators are thin, cheap deferrals
to it. Solvers are paid only in the ADA tips already posted in the orders.

Core guarantees enforced on-chain (BLUEPRINT §5.2):

- **Conservation** via exact full-value pinning of every owner output, remainder, and
  the pool — so the solver provably nets only the posted tips; ADA's three roles
  (traded / tip / min-ADA) never leak into one another.
- **Uniform price** across the batch (kills intra-batch sandwiching).
- **Per-order floor** — every order receives at least its own limit (never worse than a
  plain AMM).
- **Injective, O(N) order→output binding** via each order's unique `OutputReference`
  (no double satisfaction, no per-order NFT).
- **Pool invariant non-decreasing** including the static trading fee, owned by the pool
  validator (`k` is derived from real reserves, never stored).
- **Non-custodial**: every well-formed order is reclaimable by its owner's signature.
  *Well-formed* requires a **verification-key `owner`** (and likewise for LP-intents):
  reclaim is signature-based, so a `Script`-credential owner — which validators cannot
  reject at creation, since spend scripts don't run when a UTXO is created — would be
  settle-able/fulfillable but never reclaimable, i.e. lockable if never settled (audit
  L-01). The off-chain builders **must** set `owner` to the wallet's payment key hash.
  Relatedly, an order's `owner_stake` must not equal the settlement credential `S` (it
  would tag the payout and self-brick the settle path) — this one the anchor now rejects
  on-chain in `check_one`, so it is a clean rejection rather than a silent lock.

## Layout

### `validators/`

| Validator | Purpose |
|---|---|
| [`settlement.ak`](validators/settlement.ak) | The immutable trust anchor — an **unparameterised withdraw-0** staking script. Enumerates every input tagged with its own credential `S`, classifies each as order/pool, and enforces the curve-agnostic §5.2 batch rules (conservation, uniform price, floor, O(N) binding, deadlines, partial fills). Delegates the heavy logic to `lib/shaswap/clearing`. |
| [`order.ak`](validators/order.ak) | User-facing order validator, parameterised by `S`. `Settle` defers to the settlement anchor (and self-checks its own `S` tag); `Reclaim` is owner-signature-only. |
| [`pool.ak`](validators/pool.ak) | Constant-product pool validator, parameterised by `S`. Owns its curve: `PoolSettle` checks `k_after ≥ k_before` with the static fee; `LpAction` runs the value-derived LP deposit/withdraw; `ClosePool` tears down an unseeded pool (creator signature required). |
| [`pool_mint.ak`](validators/pool_mint.ak) | One-shot pool-creation/closure minting policy, parameterised by a seed `OutputReference` (so the pool NFT is unique). `Create` mints `{NFT, full LP supply}` into a validated pool UTXO; `Close` is burn-only. |

### `lib/shaswap/`

| Module | Purpose |
|---|---|
| [`types.ak`](lib/shaswap/types.ak) | Datum/redeemer encodings. `OrderDatum` (9 fields, incl. `pool_nft`) and `PoolDatum` (6 fields) are deliberately distinct shapes so an order can never be relabelled as the pool (§5.4). |
| [`clearing.ak`](lib/shaswap/clearing.ak) | The once-per-tx settlement check — the heart of the protocol (§5.2). |
| [`spend.ak`](lib/shaswap/spend.ak) | Spend-path logic for the order and pool validators (settle deferral, reclaim, `k`+fee check, value-derived LP, pool teardown), factored out so it is unit-testable. |
| [`mint.ak`](lib/shaswap/mint.ak) | Pool create/close mint logic, including fail-fast `PoolDatum` validation at creation. |
| [`utils.ak`](lib/shaswap/utils.ak) | Shared helpers (the `S` stake-tag check, withdraw-0 presence, asset quantity). |
| [`constants.ak`](lib/shaswap/constants.ak) | Protocol constants (total LP supply, locked `MIN_LIQ`, pool/order min-ADA, NFT/LP asset names). |
| `*_test.ak` | Unit + property tests for each area (`clearing_test`, `lp_test`, `mint_test`). |

### Trust-anchor wiring (§5.4)

Order and pool UTXOs sit at addresses whose **stake credential is the settlement
credential `S`**. The settlement validator is unparameterised (stable hash, nothing to
be circular with); at run time it learns `S` as its own withdraw account and treats
**every input tagged `S`** as the accountable set — exactly one is the pool (by NFT),
all others must parse as a well-formed `OrderDatum`. Register `S` at deployment but
**never delegate it**, or the 0-ADA withdrawal becomes illegal and settlement bricks.

## Build · test · format

```sh
aiken build          # compile validators -> plutus.json
aiken check          # run the full test suite
aiken check -m close # run only tests matching "close"
aiken fmt            # format
aiken docs           # generate HTML docs
```

Plutus v3, integer/rational arithmetic only — no floats. See
[`../documentation/spec/`](../documentation/spec/) for the clearing-price, ADA
triple-role, and partial-fill encodings, and `ex-unit-spike.md` for the per-order
verification-cost measurement that bounds the batch size (~40–50 orders/settlement).

## Resources

[Aiken user manual](https://aiken-lang.org) · [BLUEPRINT.md](../documentation/BLUEPRINT.md)
