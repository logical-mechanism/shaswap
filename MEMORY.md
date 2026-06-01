# MEMORY.md — ShaSwap project state

Durable, shared project state and working log. **This is not the design** — the
design lives in [`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md), which is
the single source of truth. This file records *where we are*, *what's next*, and
*why we got here*, and points to the blueprint for detail. Keep entries dated and
append-only-ish; don't restate blueprint content (it would drift).

## Current phase

**On-chain implementation in progress (Rev 7 design).** Anchor + order/pool/pool_mint
validators exist in `contracts/`, 31 tests green. LP deposit/withdraw + pool
create/close mint are now implemented. Still pre-production: partial fills,
bidirectional netting, and an emulator pass.

## Immediate next step

**Off-chain reference solver started — `solver-core` (milestone-1 core) is done** on
branch `batcher/reference-solver`. Next on the batcher: **`txbuild`** (lower a
`Settlement` into a Pallas tx + CBOR matching `plutus.json`) and **`chain`** (Kupo
discovery, Ogmios params/submit + **EvaluateTx pre-submit gate**), then the live
preprod loop — which is gated by the **bootstrap dependency** (deploy ref scripts,
register `S` and NEVER delegate it, create+seed a pool; scaffold in
`contracts/happy_path/`). Still owed on-chain: an **emulator pass** with a real `Data`
ScriptContext (confirms the ~40-order ceiling + decoding cost), and folding the
clearing-price/ADA-triple-role specs into exact rounding rules. Later:
**true-equilibrium** cost spike (§5.2.7), the **app** data-access layer. **Done:** trust
anchor, order/pool/pool_mint validators, LP path, pool close, bidirectional netting,
deadlines, partial fills; **solver-core** (clearing mirror + v1 floor-only solver + sim).

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

- **2026-06-01** — **Batcher milestone-1: `solver-core` (off-chain reference solver
  core).** New Cargo workspace under `batcher/` (`crates/solver-core`, pure/IO-free,
  deps: num-bigint/integer/traits only) on branch `batcher/reference-solver` (cut off
  the `contracts/audit-followup` HEAD, NOT main — main lags the contracts being
  mirrored; the batcher is decoupled so this keeps `constants.ak`/`plutus.json` in
  sync). Modules: `value` (normalized multi-asset `Value` matching `assets`), `types`/
  `output` (datum/redeemer + ledger shapes from `types.ak`; constants from
  `constants.ak`), `curve` (`reserve_of` + `k`-with-fee via `BigInt` + forward v2 swap,
  mirrors `spend.pool_settle`), **`clearing`** (the pin generator — line-for-line port
  of `clearing.ak` `run`/`process`/`check_one`; `build_settlement` returns the exact
  owner/pool/remainder outputs the anchor accepts or the matching error), `solve` (v1
  **floor-only** clearing: CoW balance price `p = Σ asset_b sold / Σ asset_a sold` +
  spot/floor-breakpoint fallbacks, net + route residual; **every result re-verified**
  against the pin generator + k-check, so it can under-solve but never emit an invalid
  tx), `sim` (synthetic-book harness). Tests: **23 green** — golden tests mirror
  `clearing_test.ak` fixtures to the lovelace (happy n1/n3, partial token-seller,
  perfect netting, ada-solo, token/token, incidental pass-through + rejections);
  property test = conservation + no-skim over 5 000 random settlements (`Σin == Σout +
  solver tip`). `cargo clippy -D warnings` clean. Sim sweep: netting 0%→**85% at N≈44**
  (rises with batch size); surplus-vs-solo is negative on imbalanced one-sided books
  (count-max v1 routes the residual at a boundary price — honest, surplus-max is the
  deferred optimal layer). Key gotchas recorded: remainder limit must be
  `ceil(limit*unsold/sell)` (floor would violate the on-chain `limit'*sell ≥
  limit*unsold`); owner loses the FULL `tip` (solver takes `tip*f/sell`, remainder keeps
  the rest); a bare-LCG PRNG's low bit cycles → use SplitMix64 for the sim generator.
  **Not yet built:** `txbuild` (CBOR/Pallas tx assembly), `chain` (Kupo/Ogmios +
  EvaluateTx gate), live loop — all gated by the bootstrap dependency.
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
- **2026-05-31** — **LP path + pool minting (Blueprint Rev 7).** Resolved the §5.1/§6
  LP-accounting conflict → **value-derived reserves + held-LP circulating supply**
  (user-chosen): reserves from pool value with **min-ADA carved out**
  (`reserve_ada = lovelace − pool_min_ada`, also applied to the swap `k`-check),
  circulating = `total_lp − held`, first-deposit shares via `is_sqrt` with `min_liq`
  permanently locked at the unspendable mint-policy address, and a single unified
  invariant: **per-share reserve backing non-decreasing in both assets** (protects LPs
  on deposit and withdraw). Implemented `spend.lp_action` + `mint.create/close` + the
  `pool_mint` one-shot policy (seed-parameterised) + `constants`. Pool `LpAction` is
  mutually exclusive with settlement. 31 tests green (added LP + mint suites). LP path
  no longer stubbed; the lone remaining `fail` is pool `Close` via the mint policy
  (full-exit spend path still TODO).
- **2026-05-31** — **Pool close + bidirectional netting.** Added `pool_close`
  (`ClosePool`) — tears down only an unseeded pool (`held == total_lp`), so live-pool
  reserves can never be stolen; completes the pool validator (no stubs). Reworked
  settlement to **bidirectional netting** (`OrderDatum.sell_ada`): token->ADA and
  ADA->token orders clear at one price and net against each other; only the residual
  moves the pool (perfect-netting leaves it untouched). Dropped the two O(N) global
  conservation folds — exact per-order + pool pinning + `mint==0` + ledger
  conservation already force the solver to take only tips; this also **lowered cost**
  (N=20: mem 7.29M→6.30M). 39 tests green (+8: close ×3, netting perfect/partial/solo,
  ada-floor + pool-shorted rejections). Cost confirms ~40-50 mem-bound ceiling holds.
- **2026-05-31** — **Deadlines + partial-fill spec.** Added `OrderDatum.deadline:
  Option<Int>`; settlement enforces per-order that the tx's finite upper validity
  bound ≤ deadline (open-ended tx can't honor a deadline; owner reclaim stays
  signature-only anytime, so expired orders are never stuck). 43 tests green (+4
  deadline). Decided the v1 **partial-fill** policy in `spec/partial-fills.md`
  (one-level remainder, solver-supplied fills, limit-price-preserving remainder,
  pre-funded min-ADA, remainder outputs enumerated alongside the NFT pool) — ready to
  implement next.
- **2026-05-31** — **Property/fuzz tests (aiken/fuzz).** Added 6 property tests (no
  design change): `clearing_test` — `prop_token_seller`/`prop_ada_seller` build a valid
  single-order settlement from fuzzed (amount, fill, price_num/den, tip) and assert
  `clearing.run` accepts it (shakes `received`/tip-split rounding + full-vs-partial both
  directions); `prop_token_seller_short_owner` (fail) — shorting the owner by 1 lovelace
  is rejected for every sample (owner pin is exact). `lp_test` — `prop_first_deposit_sqrt`
  (on-chain `is_sqrt` == `math.sqrt` across random reserves), `prop_deposit_proportional`
  (exact-proportional deposit always accepted), `prop_deposit_overmint` (fail, +1 share
  always rejected). **72 tests green.** Both `fail` props mutation-verified (flip to a
  valid build → they correctly fail). Caveat unchanged: typed-`Transaction` fuzzing does
  NOT exercise `Data` decoding / real min-ADA / ledger conservation — emulator still
  required (the solver-takes-only-tips property can only be machine-checked there).
- **2026-05-31** — **Static trading fee → Blueprint Rev 11 (Option A, residual-only).**
  User chose Option A. The pool `k`-check (`spend.pool_settle`) now enforces the
  Uniswap-v2 fee on the **net** flow into the pool: `eff_in = res_in_after − φ·Δin`,
  require `eff_a·eff_b ≥ k_in` with `φ = fee_num/fee_den`, scaled by `fee_den²` for
  integer exactness; fee charged only on the side the pool *gained* (`pos(da)`), guarded
  `0 ≤ φ < 1`. Fee retained in reserves → LP share value rises (value-derived, no
  counter). **CoW-netted volume pays nothing** (pool untouched → passes at k unchanged);
  the residual/heavy side pays from its traded asset (still ≥ its floor); solver never
  touches it. `fee_num/den` (previously dead fields) are now load-bearing. **66 tests
  green** (+5: fee-ok both directions, fee-short [k grows but < fee → rejected, the key
  new behavior], zero-residual, k-drop; mutation-checked). **Accepted economics:** LP
  yield tracks imbalance, not gross volume. `lp_action` deposits/withdrawals are
  fee-free (not trades). Remaining gap: PA-AMM λ (deferred). Possible hardening:
  validate `fee_num/den` at pool creation (`mint.create`) so a bricked-fee pool can't
  be created (today a malformed fee just makes swaps fail; LPs can still withdraw).
- **2026-05-31** — **Token/token pairs → Blueprint Rev 10.** Generalized the pool from
  "ADA + one token" to an arbitrary `(asset_a, asset_b)` pair (either side may be ADA or
  any native token), closing the §5.1/§11 "arbitrary pairs" gap (code was ADA-only).
  `OrderDatum.sell_ada` → `sell_a`; `PoolDatum`/`SettlementRedeemer` now carry
  `asset_a`/`asset_b`. New `spend.reserve_of` carves `pool_min_ada` only from an ADA
  reserve (pure overhead when neither side is ADA). All owner/remainder/pool pins are
  now **value-transforms of the corresponding input**, so ADA-as-reserve,
  ADA-as-overhead, and incidental assets are handled uniformly (this also subsumes the
  Rev 9 LP/datum pins). Guard `asset_a != asset_b` replaces `token != ADA`. **61 tests
  green** (+4 token/token: settlement happy + strip-LP, LP deposit + over-withdraw).
  Cost: N=20 mem 7.51M→7.64M (~mem-bound N≈36). **Decisions captured:** trading fee
  put **on hold** pending CoW-fee economics (§5.4 forces residual-only if implemented —
  fee_num/den remain carried-but-unenforced); PA-AMM **λ deferred** (λ=1 no-op);
  best-response is floor-only (v1). ada-triple-role spec promoted from stub.
- **2026-05-31** — **Security-review fixes → Blueprint Rev 9.** Adversarial review of
  the on-chain v1 found a **Critical** reserve-drain: settlement pinned only the pool's
  lovelace + traded token, not its **held LP** (`total_lp − circ`), so a solver could
  strip the pool's LP into its change during any settlement (even zero-order) and then
  drain reserves via `LpAction`. Same root cause leaked any **incidental asset** on an
  order to the solver, and `pool_settle`/settlement let the **pool datum** be mutated
  mid-settlement. Fix: `clearing.run` now pins the **exact full `Value`** of every
  owner-output, remainder, and the pool (reserves + NFT + held-LP) + pool datum
  continuity; owner/remainder values are derived from the spent order's own value so
  incidental assets ride through to the owner. Also rejects `token == ADA` (role
  collapse), and `pool_settle` pins datum continuity. No protocol-shape change.
  Cost: N=20 mem 7.27M→7.51M (~3%), still mem-bound ~N≈37. **57 tests green** (+9:
  LP-strip/skim, N=0 preserve/strip, junk-leak/return, datum-mutation, token==ADA).
  **Still open (flagged, not fixed — acceptable under floor-only v1):** settlement does
  not bind the pool input to a genuine pool-validator credential, so a solver can run a
  fake-pool/CoW batch with no `k`-check (users still floor-protected); and `ClosePool`
  needs no signature on an unseeded-but-reserved pool. Specs `ada-triple-role.md` /
  `clearing-price.md` should be promoted from stub and capture the floor-rounding rule.
- **2026-05-31** — **Partial fills implemented (Blueprint Rev 8).** User chose the
  **proportional-tip** variant (pay-per-fill). `clearing.ak`: solver declares per-order
  `fills`; `f < sell_amount` requires `partial==True` and produces a one-level
  (`partial==False`) remainder UTXO at the order's own address holding unsold asset +
  pre-funded min-ADA + leftover tip (`tip − tip·f/sell`); solver takes `tip·f/sell`
  now. Remainder preserves the limit *price* (`limit'·sell ≥ limit·sell'`). Pre-funds
  2× `order_min_ada` (spare returns to owner on full fill). Tagged outputs now =
  pool (NFT) + remainders (no NFT); `process` recursion threads fills+remainders and
  asserts both fully consumed. SettlementRedeemer += `fills`. 48 tests green (+6:
  partial token/ada happy, + rejections for not-allowed, shorted-remainder,
  worse-limit). Cost: partials add per-order work (N=20 mem 6.30M→7.27M → mem-bound
  ~N≈38). Safety unchanged: per-order + remainder + pool pinning + mint==0 + ledger
  conservation ⇒ solver takes only proportional tips.
</content>
