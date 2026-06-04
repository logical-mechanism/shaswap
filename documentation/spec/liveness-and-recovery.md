# Liveness, order rollover, and fund recovery

> What happens to an order between "posted" and "done" — and exactly how a user always
> gets their funds back. This is the honest statement of ShaSwap's censorship-resistance
> and liveness guarantees. Source: BLUEPRINT §3 (principles), §5 (settlement), §7.

## Order lifecycle

A posted order is a UTXO at the order address (a plain payment with an inline
`OrderDatum`; no script runs at creation). From there exactly three things can happen:

1. **Settled** — a solver includes it in a uniform-price batch. It receives at least its
   `limit` (the per-order floor, §5.2.5); the solver takes only the posted tip. On a
   partial fill, the filled part settles and a reclaimable **remainder** UTXO is left.
2. **Deadline reached** — if the order set a `deadline`, no solver may settle it after
   that point. It does not auto-refund; it becomes reclaim-only.
3. **Reclaimed** — the owner spends it back to themselves at any time, by signature.

## Rollover (uncleared orders)

There is **no forced expiry and no automatic rollover**. An order that isn't cleared in
the next batch simply **rests** as a live UTXO and remains eligible for the *next* batch,
indefinitely, until one of the three outcomes above occurs. Practical implications:

- An order with **no deadline** rests until a solver settles it or the owner reclaims it.
- An order with a **deadline** rests until settled, or until the deadline — after which
  only reclaim is possible.
- Resting orders tie up the user's funds (sold asset + 2 ADA min + tip) until resolved.
  The dApp lists them under **Orders** with a one-click reclaim.

The batch ceiling (~40–50 orders/settlement, see [`ex-unit-spike.md`](ex-unit-spike.md))
bounds how many orders clear per tx; excess orders roll forward to subsequent batches.

## The recovery guarantee (non-custodial)

**Every well-formed order is reclaimable by its owner's signature, always.** This is the
core non-custodial property: funds are controlled only by the owner's key plus public
validator logic — no solver, operator, or admin can withhold them.

Caveats users must understand:

- **Collateral is required to build a reclaim tx.** Reclaim spends a script UTXO, so the
  wallet needs a collateral UTXO. The dApp surfaces a "set collateral" prompt when one is
  missing; a wallet with *no* spare UTXOs must first receive/split some ADA.
- **Order owner must be a verification key.** Reclaim is signature-based, so the
  `OrderDatum.owner` must be a VK credential. A script-credential owner could be *settled*
  but **not reclaimed** — a permanent footgun. The dApp **only ever builds VK-owner
  orders** (`buildOrder` rejects anything else); do not hand-craft script-owner orders.
- **Malformed/stranded sends are rejected by design.** A payment to the order address
  with a malformed or absent datum is not a valid order and is not recoverable through the
  protocol — send only via the dApp (or a correct client).

## Censorship-resistance & liveness — the honest statement

ShaSwap's liveness rests on the **solver role being permissionless**: anyone may run a
batcher, so no single operator can censor the book — a competitor (or the user) can settle
what one solver ignores.

What this does **not** mean in v1, stated plainly:

- **There is no client-side self-solve in the dApp.** Only the Rust reference batcher can
  build a settlement. If you are being ignored, your *practical* recourse is to (a) wait
  for any solver to pick up your order, (b) run a batcher yourself, or (c) **reclaim** and
  walk away. Running your own batcher is the censorship backstop; the dApp does not yet
  ship a one-click "settle my own order" button.
- **The "AMM fallback" is a price floor, not a swap path.** The per-order `limit` (§5.2.5)
  guarantees you never settle *worse* than a plain AMM would have given — it does **not**
  give you a way to swap without a solver. With zero solvers, nothing settles; you reclaim.

For liveness assurance at launch, operators are encouraged to run **≥2 independent
reference batchers** (different hosts/regions) so a single solver outage doesn't stall the
book. This is operational defense-in-depth, not a protocol requirement. See
[`../launch/batcher-operations.md`](../launch/batcher-operations.md).
