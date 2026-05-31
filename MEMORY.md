# MEMORY.md — ShaSwap project state

Durable, shared project state and working log. **This is not the design** — the
design lives in [`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md), which is
the single source of truth. This file records *where we are*, *what's next*, and
*why we got here*, and points to the blueprint for detail. Keep entries dated and
append-only-ish; don't restate blueprint content (it would drift).

## Current phase

**Ex-unit spike done; thesis validated.** Blueprint is at **Rev 5**. Throwaway
measurement code lives in `contracts/` (settlement/order validators + spike tests) —
**not production**; real implementation has not started.

## Immediate next step

**Ex-unit spike DONE (2026-05-31) — thesis viable.** ~40–50 orders/settlement with
**mandatory O(N) positional binding**; memory-bound; naive O(N²) caps at ~24. See
[`documentation/spec/ex-unit-spike.md`](documentation/spec/ex-unit-spike.md) and
BLUEPRINT §13.1. **Next:** (1) spike the **true-equilibrium** verification cost
(§5.2.7/§12.2) — it gates surplus distribution; (2) re-measure under an emulator with
a real `Data` ScriptContext to confirm the planning N (typed-value tests under-count
decoding); (3) then start real on-chain implementation, keeping the O(N) binding as a
hard requirement.

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

- ~~Ex-unit feasibility (§13.1)~~ — **resolved 2026-05-31: viable, ~40–50 orders/
  settlement, O(N) binding mandatory, memory-bound.** (Equilibrium variant still TBD.)
- Surplus-distribution rule & its verification cost (§12.2 / §5.2.7) — needs its own
  spike (est. lowers N to ~30–40).
- Solver tip mechanics; batch-size bounds; partial-fill min-ADA funding; rational
  clearing-price encoding; `λ`/fee defaults; sharding defaults; data provider choice.

## Log

- **2026-05-31** — Blueprint reached Rev 4 after two design reviews. Repo-level
  `CLAUDE.md` + `MEMORY.md` created; `BLUEPRINT.md` moved into `documentation/`.
  Key review outcomes folded in: double-satisfaction rule, withdraw-0 "checks every
  input", static fees, ADA triple-role accounting, first-LP inflation guard,
  `k`-not-stored, solve-cost honesty (v1 solve is cheap), malformed→reject.
- **2026-05-31** — **Ex-unit spike (§13.1) measured → Blueprint Rev 5.** Built a
  minimal withdraw-0 settlement validator (both naive O(N²) and indexed O(N) binding),
  an O(1) order-spend deferral, and a synthetic N-sweep (N=1…100) in `contracts/`.
  Result: **memory-bound** in every case; **indexed O(N) → ~40–50 orders/settlement**
  (conservative N≈47, CPU ~105, size ~100), **naive O(N²) collapses at ~24** →
  canonical/positional binding is now a hard requirement. Withdraw-0 deferral cost is
  negligible (confirms §5.4). Caveat: typed-value tests under-count `Data` decoding —
  confirm via emulator before mainnet. Report:
  `documentation/spec/ex-unit-spike.md`. Code is throwaway (measurement only).
</content>
