# MEMORY.md — ShaSwap project state

Durable, shared project state and working log. **This is not the design** — the
design lives in [`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md), which is
the single source of truth. This file records *where we are*, *what's next*, and
*why we got here*, and points to the blueprint for detail. Keep entries dated and
append-only-ish; don't restate blueprint content (it would drift).

## Current phase

**Pre-implementation / design locked.** Blueprint is at **Rev 4** (full design,
threat model, risks). No production code yet; repo skeleton exists (`app/`,
`batcher/`, `contracts/`, `documentation/`).

## Immediate next step

**The make-or-break ex-unit spike — BLUEPRINT §13.1.** Build a minimal Aiken
withdraw-0 settlement validator that checks the §5.2 rules over a synthetic batch of
N orders, and measure mem/step/tx-size usage to find the real **orders-per-settlement
ceiling**. This number bounds the contention win, the netting benefit, and whether
full-equilibrium surplus (§5.2.7) is affordable. Decide architecture *after* this.

## What's decided (authority: BLUEPRINT §3, §5, §12 "Resolved" — see there for detail)

High-signal pointers only:
- Batch-auction DEX; uniform price; **first-valid-wins** solver; per-order floor.
- **Settlement validator = immutable trust anchor**; pool curves **pluggable**
  underneath it; once-per-tx via **withdraw-0** (must check every input).
- **Solver reward = ADA tips** (no minted token).
- **Static low fees** in v1; dynamic fees deferred.
- **No oracle in the core** (mortal-dependency rule); LVR is *mitigated*, not cured.
- **Malformed inputs strictly rejected** (no `True` on value paths).
- **No double satisfaction** via injective `OutputReference` binding; **`k` derived,
  not stored**.
- Stack: Aiken / Rust+Pallas / TS-React+MeshJS / hosted provider behind a swappable
  data-access abstraction.

## Open / unresolved (authority: BLUEPRINT §12 + §13)

- Ex-unit feasibility (§13.1) — *existential, measure first*.
- Surplus-distribution rule & its verification cost (§12.2 / §5.2.7).
- Solver tip mechanics; batch-size bounds; partial-fill min-ADA funding; rational
  clearing-price encoding; `λ`/fee defaults; sharding defaults; data provider choice.

## Log

- **2026-05-31** — Blueprint reached Rev 4 after two design reviews. Repo-level
  `CLAUDE.md` + `MEMORY.md` created; `BLUEPRINT.md` moved into `documentation/`.
  Key review outcomes folded in: double-satisfaction rule, withdraw-0 "checks every
  input", static fees, ADA triple-role accounting, first-LP inflation guard,
  `k`-not-stored, solve-cost honesty (v1 solve is cheap), malformed→reject.
</content>
