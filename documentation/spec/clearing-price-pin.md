# Spec — Clearing-price pin: close the floor→fair corridor on-chain (BLUEPRINT §5.2.5/§5.2.7/§5.4)

> **Status:** DEPLOYED — BLUEPRINT Rev 25, live on preprod and mainnet (2026-06-08).
> Implements the fix for an internal economic-soundness review finding (the solver-LP
> floor→fair corridor). This spec **defines correctness** for the two-sided price pin in
> `spend.pool_settle` and the `lp_intent` exact-proportional pin.

## 1. The problem, exactly

The settlement anchor verifies **validity, not optimality**. Two price checks run:

- **Per-order floor** ([`clearing.ak:208`](../../contracts/lib/shaswap/clearing.ak#L208)/`:219`):
  `order.sell_amount · price_num ≥ order.limit · price_den` — uses the **full** sell amount,
  so it only enforces *each trader's own limit*.
- **Pool `k` non-decreasing** ([`spend.ak:106`](../../contracts/lib/shaswap/spend.ak#L106)):
  `eff_a·eff_b ≥ res_a_in·res_b_in·fee_den²` — a **one-sided `≥`**.

The uniform clearing price `p` is therefore free in the closed interval
**`[order-floor price, AMM-curve price]`**. Underpaying a trader *raises* `k` (less paid
out ⇒ higher `res_out` ⇒ more slack), so the `k`-check **only caps the top** of the
interval; nothing pins the bottom. The surplus between the trader's floor and the fair
curve price banks into the pool as higher `k`, captured pro-rata by LPs and
disproportionately by an LP-holding solver. The price-blind tip
([`clearing.ak:188`](../../contracts/lib/shaswap/clearing.ak#L188)) means the solver
auction exerts **zero** pressure to close it.

**This is not a custody bug** — owner/pool/tip pins make fund theft impossible; the leak
is purely *price*. See the review for the full mechanism and magnitudes (~0.7% on a tight
2% limit; up to ~99.99% on a market order; deterministic under a profit-maximizing
solver-LP).

### 1.1 The reference solver already underpays one-sided flow

Confirmed in the batcher, not just in theory. [`solve.rs`](../../batcher/crates/solver-core/src/solve.rs)
scans candidate prices (`balance_price` + nudges, `spot_price`, then each order's
`floor_price`) and picks the feasible candidate **including the most orders, tie-broken by
smallest residual** (`solve.rs:317-327`). On a **well-netted** book it clears near the
balance price (≈ fair, residual ≈ 0 — good). On a **one-sided / imbalanced** book there is
no balance price and spot is infeasible (any one-sided residual overpays at spot), so it
**falls back to an order floor price** — the bottom of the corridor. So even an honest,
non-LP operator running the reference code underpays imbalanced flow today. The fix is a
real quality upgrade to the solver, enforced by the chain.

## 2. The fix — a two-sided price pin in the pool validator

Add the **missing lower edge** to the pool's curve check, in
[`spend.pool_settle`](../../contracts/lib/shaswap/spend.ak#L57) only. The pool already
knows the curve; the anchor stays curve-agnostic (§5.4). With the pool's reserve deltas

```
net_a = res_a_out − res_a_in
net_b = res_b_out − res_b_in
```

exactly one of three cases holds (the residual is one-directional, or zero):

- **Pool took asset_a, paid asset_b** (`net_a > 0`, `net_b < 0`): the pool must release the
  **full curve amount** for `net_a`, not less:
  ```
  −net_b ≥ get_amount_out(net_a, res_a_in, res_b_in, φ) − ε
  ```
- **Pool took asset_b, paid asset_a** (`net_b > 0`, `net_a < 0`): symmetric, with
  `get_amount_out(net_b, res_b_in, res_a_in, φ)`.
- **No residual** (`net_a == 0 ∧ net_b == 0`): the pool did not move — see §4 (the residue).

The **existing one-sided `k`-check is kept** (it already enforces the *upper* bound
`−net_b ≤ get_amount_out(net_a)` — the test at
[`curve.rs:132`](../../batcher/crates/solver-core/src/curve.rs#L132) shows paying `dy`
passes and `dy+1` fails). The new floor adds the *lower* bound. Together the pool's payout
is pinned to **`[fair − ε, fair]`**.

### 2.1 Why pinning the pool aggregate pins every order's price

The pool's residual always trades at the single uniform price: from
[`clearing.ak`](../../contracts/lib/shaswap/clearing.ak) each a-seller contributes
`(d_a=+f, d_b=−f·p)` and each b-seller `(d_a=−f/p, d_b=+f)`, so

```
net_b = −net_a · p        (exact, modulo per-order flooring)
```

Pinning `−net_b` to `get_amount_out(net_a)` forces `p = get_amount_out(net_a)/net_a` — the
curve execution price for the residual volume. Because **all** orders clear at that same
`p` (uniform-price, §5.2.2), pinning the aggregate pins every order. This is exactly the
batch-cfmm uniform-price equilibrium for the residual-fee constant-product curve — i.e. the
deferred §5.2.7 best-response, recovered for free from the curve the pool already checks,
**whenever the residual is non-zero**.

## 3. `get_amount_out` — the curve helper (bit-exact with the batcher)

Mirror [`curve.rs:swap_out`](../../batcher/crates/solver-core/src/curve.rs#L96) exactly
(it already mirrors `spend.ak`):

```
γ        = fee_den − fee_num
dy(dx)   = floor( res_out · dx · γ / (res_in · fee_den + dx · γ) )
```

with `dx = net input (>0)`, `res_in/res_out` the *pre-trade* reserves of the in/out side
(min-ADA already carved by `reserve_of`, [`spend.ak:18`](../../contracts/lib/shaswap/spend.ak#L18)).
Integer floor division; no floats (Principle 4). `dy` is the **maximum** the pool may pay
(the `k`-edge), so it is the fair amount we pin **down to**.

## 4. The rounding tolerance `ε` — the one thing to get exactly right

The anchor floors each order's `received = floor(f·num/den)`
([`clearing.ak:201`](../../contracts/lib/shaswap/clearing.ak#L201)/`:211`), so the
aggregate `−net_b = Σ received` is a sum of floored terms and is **not** equal to the single
floored `get_amount_out(net_a)`. An honest fair solve therefore lands a few sub-units
below `get_amount_out`. `ε` must absorb exactly that, and no more.

**`ε` MUST be an absolute, batch-size-derived bound — never a fraction of `k`.**

- Each of the `N` floored per-order payouts loses `< 1` sub-unit ⇒ the achievable honest
  `−net_b ≥ get_amount_out(net_a) − N`. So **`ε = N`** (the number of settled orders) is
  sufficient for liveness and bounds any underpayment leak to **`≤ N` sub-units of the
  paid asset per batch** (≤ ~34 sub-units — economically nil vs the ~9.87 ADA corridor it
  closes). A small constant margin (e.g. `ε = N + c`) may be needed; the differential test
  (§6) pins the exact value.
- A **relative** `ε` (e.g. `0.01%·k`) is the dangerous mistake: it maps to ≈ `ε/slope`
  lovelace of reopened underpayment (`slope = d(k)/d(payout) ≈ 1e12` at a deep pool), i.e.
  ~0.1 ADA/order, scaling with pool depth and token decimals — a narrower corridor, not a
  closed one. Forbidden.
- **`N` on-chain.** `pool_settle` does not currently enumerate orders. Options: (a) count
  the `S`-tagged order inputs in `pool_settle` (tight, ungameable across all token
  decimals; small ex-unit cost); (b) a conservative constant `ε = MAX_BATCH` (~64; simpler,
  but leaks up to 64 sub-units of a 0-decimal high-value token in the worst case). **Lean
  (a)**; confirm cost in the §6 measurement. Pin `ε` **on the amount** (sub-units of the
  paid asset), never on the `k`-product.

## 5. The accepted residue (Scope A) — perfectly-netted batches

When the book nets perfectly the pool does not move (`net_a = net_b = 0`), so the pin is
vacuous and `p` is free within the overlap of the two matched orders' floors. **This is
deliberately left open in v1.** Rationale:

- It is a **trader↔trader transfer**, not a leak to the pool/solver: one matched trader's
  loss is the other's gain, bounded by both their own limits (tight limits ⇒ ≈ 0).
- **No solver-LP harvest incentive exists here** — the pool is untouched, so `k` is
  unchanged and an LP-solver banks nothing. The only beneficiary is a solver that is itself
  one of the matched counterparties, and even then it is bounded by the victim's limit.
- Closing it requires a per-order equilibrium/best-response check that must be
  **curve-aware inside (or beside) the immutable anchor** — bloating the frozen trust root,
  forcing a re-audit of `S`, and costing ex-units that lower batch size `N`. The cost/risk
  is disproportionate to a bounded trader↔trader residue.

**Mitigation:** app-side tight default limits and never emitting a true market order (§7).
**Insurance:** run the §13.1 ex-unit spike for the full §5.2.7 equilibrium check in
parallel (Phase 4), so the "ever close the residue" decision is made with real numbers
before the anchor freezes at mainnet — **A does not foreclose B.**

## 6. Verification (the make-or-break gate)

A **differential / property test** (`spend` test + a Rust↔Aiken parity test) over a grid of
`(pool depth, fee, token decimals on each side, N, one-sided vs netted vs mixed,
partial-fill mix)` must show, in one run:

1. **Liveness:** every honest fair solve (residual routed at `get_amount_out`) **passes**
   the floor — no DEX-darkening. This fixes the lower bound on `ε`.
2. **Ungameability:** the worst-case underpayment that still passes, converted to the paid
   asset, is `≤ ε` sub-units (`≤ N`). This fixes the upper bound on `ε`.
3. If the liveness `ε` and the ungameable `ε` **cross**, the amount-pin alone is
   insufficient and we escalate (revisit per-order band / Scope B). Expectation: they do not
   cross — they are separated by the `Σfloor` vs `floor(Σ)` gap, which is `< N`.

Plus: `aiken build` + `plutus.json` diff must show **only `pool` (and `lp_intent`, §8)
hashes changed**; `settlement` (`S = a305a3cf…`), `order`, `pool_mint` **byte-identical**
(hard gate; CI fails on drift).

## 7. Downstream consequences (other phases)

- **Batcher (Phase 2):** add the **fair-equilibrium price** as a (preferred) candidate in
  `solve.rs` — the `p` whose residual lands on `get_amount_out` — so the reference solver
  clears at fair and its settlements satisfy the new floor. The existing balance-price path
  already does this for netted books; the change targets one-sided/imbalanced books.
  Re-verify against the new pin (`solve.rs` already re-verifies the k-check).
- **App (Phase 3):** the slippage limit reverts to its honest meaning — an **abort
  condition** ("don't trade me worse than X"), not the execution price. Correct the
  "settles at one fair price / never worse than an AMM" copy.

## 8. LP-intent path — close its (milder) corridor too (not frozen)

[`lp_intent.ak`](../../contracts/lib/shaswap/lp_intent.ak) pins the pool output exactly but
floors `released_a/_b` only by `min_a/min_b` (`:153-154`) with the **max** capped by the
pool's per-share backing (`spend.ak:215-216`). Same one-sided structure ⇒ same corridor,
milder (under-fill donates to remaining LPs; solver captures only θ). Since `lp_intent` is
**not** in the frozen set and we are relaunching it anyway, **pin both directions to an
exact `==` (no floor-range on either side)**:

```
withdraw:  released_a == floor(res_a_in · L / circ_in)        (and _b)
deposit:   dep_a      == ceil(shares · res_a_in / circ_in)    (and _b)   [the AT-RATIO pin]
```

The backing check already bounds the *max*; pinning to it closes the corridor at ~zero
ex-unit cost. No curve/`get_amount_out` needed (LP actions are proportional, not swaps).

**Deposit symmetry (the at-ratio pin).** The deposit pin is the *mirror* of withdraw, and
the direction matters. The earlier form derived `shares == min(floor(dep_a·circ/res_a),
floor(dep_b·circ/res_b))` **from** the batcher-chosen `dep` — which still let an **off-ratio**
deposit (stale quote, mid-rest price move, third-party client) over-supply the non-binding
side into the pool *unbacked*, donating it pro-rata to existing LPs (the same corridor,
narrowed to off-ratio deposits, bounded by the depositor's own over-supply; `min_shares`
can't catch it). The fix inverts the dependency: the solver declares `shares`, and the pool
may absorb only the **minimal at-ratio amount** that backs them, `need = ceil(shares·res_in/
circ_in)` (Aiken has no `ceil`: `(x + y − 1) / y`). `ceil` is the smallest `dep` with
`dep·circ_in ≥ res_in·shares`, so the pool's per-share backing always passes (no liveness
loss), and because it is *minimal*, every off-ratio over-supply is forced back to the owner
by the unchanged exact owner-payout pin — never silently donated. The batcher's
`deposit_plan` already computes `dep = ceil(res·shares/circ)` and returns the remainder, so
it is **bit-exact** with this pin (Rust↔Aiken parity test `deposit_dep_matches_contract_ceil_pin`);
no batcher logic change. This re-hashes **only `lp_intent`** (`f30fb448 → 05451fe2`); the
`pool` pin and the frozen anchor are untouched.

## 9. Blueprint changes (companion edits)

- **§5.2.5** — restate the guarantee honestly: with the pin, execution is **at the fair
  curve price** (the order's limit becomes an *abort* condition, like Uniswap slippage), not
  merely "≥ your own limit." Remove the false "Uniswap parity guaranteed" / "never worse
  than a plain AMM (against the curve)" conflation at lines 560 and 821.
- **§5.2.7** — v1 now ships the **price pin** (curve-execution equilibrium for the residual)
  in the pool validator; the *full* equilibrium (closing the netted residue) remains
  deferred, with the ex-unit spike scheduled.
- **§5.4** — note the pool validator now owns a **two-sided** curve pin (still no curve in
  the anchor); add `get_amount_out` to the pool's responsibilities.
- **§8 threat model** — the "self-dealing solver clears at the floor" row: worst case is now
  **fair-curve execution** (pin), not "Uniswap-parity-but-actually-the-floor". Residue
  scoped to perfectly-netted trader↔trader.
- Bump `Revision:` (Rev 24 → Rev 25) + changelog.
