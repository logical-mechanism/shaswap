# MEMORY.md — ShaSwap project state

Durable, shared project state and working log. **This is not the design** — the
design lives in [`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md), which is
the single source of truth. This file records *where we are*, *what's next*, and
*why we got here*, and points to the blueprint for detail. Keep entries dated and
append-only-ish; don't restate blueprint content (it would drift).

## Current phase

**On-chain implementation started (Rev 6 design).** Production trust anchor +
order/pool validators exist in `contracts/` with a green test suite (14 tests: happy
paths + safety negatives). The spike code has been **superseded/removed**. Still
pre-production: LP deposit/withdraw, partial fills, bidirectional netting, LP/pool-NFT
minting policies, and an emulator pass are not done.

## Immediate next step

**Continue the contract build on top of the green anchor.** Highest-value next pieces:
(1) **LP path** on the pool validator (deposit/withdraw, share tokens, first-LP guard
§6) — currently stubbed `fail`, MUST let LPs always exit before production; (2) the
**pool-NFT + LP-token minting policies**; (3) **partial fills** (per `spec/partial-fills.md`)
and **bidirectional netting** (orders both directions clearing at one price); (4) the
clearing-price/ADA-triple-role specs into the validator. **Before finalizing:** spike
**true-equilibrium** cost (§5.2.7); **emulator** re-measure with real `Data`
ScriptContext + a partial-fill mix.

## What's decided (authority: BLUEPRINT §3, §5, §12 "Resolved" — see there for detail)

High-signal pointers only:
- Batch-auction DEX; uniform price; **first-valid-wins** solver; per-order floor.
- **Settlement validator = immutable trust anchor**; pool curves **pluggable**
  underneath it; once-per-tx via **withdraw-0** (must check every input).
- **Solver reward = ADA tips** (no minted token).
- **Static low fees** in v1; dynamic fees deferred.
- **No oracle in the core** (mortal-dependency rule); LVR is *mitigated*, not cured.
- **Malformed inputs strictly rejected** (no `True` on value paths).
- **No double satisfaction** via injective `OutputReference` binding **+ mandatory
  O(N) positional binding** (§5.2.6); **`k` derived, not stored, and owned by the pool
  validator** (settlement is curve-agnostic, §5.4 split).
- **Trust-anchor wiring = stake-credential tag `S`** (Rev 6, §5.4): order/pool UTXOs
  are stake-delegated to `S`; settlement is **unparameterised**, finds its inputs by
  `S`, identifies the pool by its NFT — resolves the order↔settlement hash circularity.
- **v1 batch cap ≈ 40 orders/settlement** (§5.3); **v1 = floor-only, equilibrium
  deferred** (§5.2.7).
- Stack: Aiken / Rust+Pallas / TS-React+MeshJS / hosted provider behind a swappable
  data-access abstraction.

## Open / unresolved (authority: BLUEPRINT §12 + §13)

- ~~Ex-unit feasibility (§13.1)~~ — **resolved: viable, ~40–50, O(N) binding, mem-bound.**
- ~~Trust-anchor wiring / k-ownership split / binding-O(N)~~ — **resolved Rev 6 (§5.4/§5.2).**
- ~~Surplus rule (v1)~~ — **resolved: v1 floor-only;** equilibrium cost still needs its
  own spike (est. lowers N to ~30–40).
- **Spec stubs to finish** (`spec/partial-fills.md`, `spec/clearing-price.md`,
  `spec/ada-triple-role.md`) → full specs during the deep dive.
- Solver tip mechanics; order rollover; `λ`/fee defaults; sharding defaults; data
  provider choice.

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
- **2026-05-31** — **Pre-implementation design lock → Blueprint Rev 6.** Resolved the
  architecture forks the spike exposed, before the contract deep dive: (A1) O(N)
  positional binding promoted to a hard invariant (§5.2.6); (A2) trust-anchor wiring =
  **stake-credential tag `S`** with an **unparameterised settlement validator** that
  finds its inputs by `S` and the pool by NFT — breaks the order↔settlement hash
  circularity (§5.4); (A3) **settlement curve-agnostic / pool owns `k`** split
  (§5.2.3/§5.4); recorded v1 batch cap ≈ 40 (§5.3) and v1 = floor-only (§5.2.7). Added
  spec stubs `spec/{partial-fills,clearing-price,ada-triple-role}.md` (A4/A5). Next:
  start real validators against Rev 6.
- **2026-05-31** — **Production contracts (Rev 6) — first cut, green.** Replaced the
  spike with real validators: `settlement` (unparameterised withdraw-0 anchor;
  stake-tag enumeration, datum-shape role-ID, O(N) positional binding, curve-agnostic
  conservation/price/floor checks), `order` (param by `S`; `Settle` self-enforces the
  tag, `Reclaim` owner-sig), `pool` (param by `S`; owns `k`, NFT continuity; LP path
  stubbed). Lib: `clearing`, `spend`, `utils`, `types`. 14 tests pass incl. negatives
  for value-theft, mis-binding, fake-pool, floor-breach, untagged-smuggle, k-drop.
  Found + recorded: §5.4 pool-vs-order role-ID by datum shape (closes a relabel-drain
  path); §5.4 "register `S`, never delegate or withdraw-0 bricks" hazard. Aiken note:
  this version silently panics (exit 1, no diagnostic) on a validator/module name
  collision, an unimported annotated type, and `use`-ing a validator module from
  another module — factor validator logic into lib fns and test those.
</content>
