# Spec — ADA's three roles, both trade directions (A5 / BLUEPRINT §5.2.1)

> **Status:** IMPLEMENTED (Rev 10), spec text still being fleshed out. `clearing.ak`
> handles the general `(asset_a, asset_b)` pair both directions, incl. **selling ADA**
> (the hard case: one lovelace field = traded + tip + min) and the **token/token pair**
> (the easy case: lovelace = tip + min only, never traded). The mechanism is a
> **full-value pin via input transform** — each owner/remainder/pool output is pinned
> as the corresponding input value shifted by the trade deltas, so the three roles
> never leak regardless of which side is ADA. `spend.reserve_of` carves `pool_min_ada`
> out only when the reserve side is ADA. Remaining: write the exact rounding rules +
> property tests.

## The three roles (must never leak into one another)

- **traded-ADA** — ADA as one side of the traded pair (only when the pair includes ADA).
- **tip-ADA** — the solver reward posted in the order (§7).
- **min-ADA** — per-UTXO ledger overhead, preserved across the order→owner-output.

The solver may take **only** tip-ADA (§5.2.1); conservation must hold per-role.

## Case 1 — pair is `TOKEN / ADA`, order **buys ADA** (sells TOKEN) — *measured*

- Order input value: `TOKEN: sell` + `ADA: (min_ada + tip)`.
- Owner output: `ADA: (min_ada + received)` — keeps its min-ADA, gains traded-ADA
  (`received`), tip removed.
- Pool: `+sell` TOKEN, `−received` ADA (traded-ADA only).
- Solver: `+tip`.
- Disambiguation is easy: the order's ADA is *not* the traded side on the way in
  (it's min+tip); traded-ADA only appears on the output.

## Case 2 — pair is `TOKEN / ADA`, order **sells ADA** (buys TOKEN) — *the hard case*

- Order input value: `ADA: (traded_in + tip + min_ada)` — **all three roles in one
  field.** They cannot be inferred from the value alone.
- **Resolution:** the `OrderDatum` states the **`sell_amount` (traded-ADA in)** and the
  **`tip`** explicitly; `min_ada = input_lovelace − sell_amount − tip` is the
  remainder. The validator checks `input_lovelace ≥ sell_amount + tip + min_ada_floor`
  and treats the three slices separately:
  - traded-ADA `sell_amount` → into the pool;
  - tip → to the solver;
  - min_ada → preserved into the owner output (which receives `TOKEN: received`).
- Owner output: `TOKEN: received` + `ADA: min_ada` (its preserved overhead).
- This is why **tip and traded-amount are explicit datum fields** — never derived from
  the lovelace total.

## Case 3 — pair is `TOKEN_A / TOKEN_B` (no ADA side)

- No traded-ADA role. Order input: `TOKEN_A: sell` + `ADA: (min_ada + tip)`. Owner
  output: `TOKEN_B: received` + `ADA: min_ada`. Pool moves only the two tokens. Same
  as Case 1 minus the traded-ADA subtlety. Simplest case.

## Invariants to encode

- [ ] Per-role conservation as **three independent equations**, not one lumped ADA sum.
- [ ] `tip` and traded-amount are **explicit datum fields**; min-ADA is the residual,
      bounded below by the protocol/ledger min.
- [ ] Solver output ADA == Σ tips of *included* orders (no more).
- [ ] Reject if `input_lovelace < sell_amount + tip + min_ada_floor` (Case 2).
- [ ] Confirm the §5.2.1 conservation check handles all three cases without a special
      path that could return `True` on malformed splits (§3.2 default-deny).

## Open items

- [ ] Decide exact `min_ada_floor` source (static constant vs. computed).
- [ ] Add tests covering all three cases (the spike only covered Case 1).
