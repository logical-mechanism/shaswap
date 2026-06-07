# Economic & Mechanism-Design Soundness Report — ShaSwap

**Subject:** ShaSwap protocol economics (a uniform-price, permissionless, non-custodial batch-auction eUTXO DEX) — **not** a code-security review.
**Date:** 2026-06-05 · **Branch:** `contracts/lp-intents` (post-Rev-24) · **Scope:** the economic *mechanisms*, assuming the validators correctly enforce what they claim (contracts separately audited through Rev 24).
**Method:** Full read of `BLUEPRINT.md`, every `documentation/spec/*.md`, and the actual Aiken logic (`clearing.ak`, `spend.ak`, `mint.ak`, `lp_intent.ak`, `types.ak`, `constants.ak`), then a 10-dimension multi-agent adversarial sweep with **per-finding numeric + on-chain-constraint verification** (66 agents; 49 surviving findings, 1 refuted/dropped) and quantitative modelling against `lvr.pdf` / `batch-cfmm.pdf`. Every claim is anchored to enforced code; verifier-corrected tiers are used throughout.

> **Why this exists / how to use it.** This is a standing reference for deciding whether to (a) close the clearing-price corridor on-chain (a contract revision, while the anchor is still pre-mainnet/mutable), (b) make the app-side mitigations (tight default limits, real tip floors, anomalous-backing warnings) load-bearing, or (c) sign off the corridor as an accepted residual and re-scope the public claims. The single highest-leverage decision is item **§7.1 / §7.4** (equilibrium-vs-floor, gated on the ex-unit spike). The frozen anchor is `settlement`/`clearing` + the param-applied `order`/`pool`/`pool_mint`; **`lp_intent` is NOT frozen** (see §7.10), so the cheapest wins live there and app-side.

---

## 1. Executive Summary

**Overall economic-soundness verdict: Fragile** — with an important asymmetry.

ShaSwap's *trust base* is genuinely sound. The settlement anchor's full-value pins, `mint==0`, the `owner_stake != S` guard, proportional-tip floor-rounding, and the dual-pin LP-intent structure mean a solver can never seize funds, redirect a payout, overcharge tips, or move any co-batched order *below that order's own limit*. **Intra-batch sandwiching is structurally and unconditionally eliminated.** On custody and sandwich-MEV it is strictly better than the Cardano incumbents and Uniswap respectively.

But on the orthogonal question this report answers — are the economic *mechanisms* sound given they are correctly enforced — the protocol is **Fragile**, and the fragility is **singular in origin**. The settlement validator verifies only each order's own *floor* and the pool only that `k` is non-decreasing; it never verifies *best-response / equilibrium* (the batch-cfmm fourth axiom, deliberately deferred — BLUEPRINT §5.2.7, Rev 11). This leaves the uniform clearing price **free within a corridor** `[order-floor price, AMM-k-preserving price]`. And because "first-valid-wins" is a **latency** race with no **quality** objective, nothing — not permissionless entry, not the tip auction — competes that corridor down to the fair price. The result is a hidden, regressive transfer from loose-limit traders to LPs (and disproportionately to an LP-holding solver), invisible to every chain-paid incentive.

The mechanism is sound only under assumptions that do **not** hold by default: that flow is dominated by tight-limit orders, that no large LP runs a solver, and that an aligned operator subsidizes the unfunded periphery. Where those hold, it is a real advance. Where they fail, it degrades to soft-centralized, floor-only execution that can be **worse than a plain AMM** for a loose-limit order.

**Top economic risks (ranked):**

1. **The floor-only clearing corridor (Critical, Confirmed).** A `limit=1` order can legally be cleared at ~1 base unit — surrendering ~99.99% of fair value into the pool as higher `k` — because the floor check uses the full `sell_amount` against a near-zero limit and the `k`-check only *rises* as the trader is underpaid. A "5% slippage tolerance" order does not lose *up to* 5%; under a profit-maximizing solver-LP it loses *exactly* 5%, every time.

2. **The corridor is uncompetable by the tip auction (High, Confirmed).** The chain pays the solver only the posted tip, identical at every price in the corridor; the surplus banks as `k`-appreciation, invisible to tips. Unlike CoW — whose auction objective *selects the surplus-maximizing solver* — ShaSwap's latency race exerts zero pressure on execution quality.

3. **Per-block natural monopoly + soft-centralized rent (High, Confirmed).** The single pool UTXO is a one-spend-per-block serialization point, so exactly one solver wins each pool each ~20 s block on latency alone. Permissionless entry caps the *tip* rent at break-even but not the corridor rent or inclusion/censorship control.

4. **Static fee + λ=1 + no oracle under-compensates volatile-pair LPs (Medium, Confirmed).** Per-block LVR is convex (break-even needs φ ≥ jump/2), so a 0.30% fee recovers only ~20% of a single 3% block's LVR. This is Uniswap-v2-parity in kind; ShaSwap's marginal weakness is *immutability*, which forecloses the v3/v4 remedies. Apparent volatile-pair LP health is propped up by the corridor.

5. **Cold-start and unfunded-periphery liveness dependency (Medium, Likely).** A cold pool produces near-zero tips; the frontend, data index, and development are funded by *no* tip level at all. Lived liveness depends on at least one aligned operator subsidizing the periphery — a soft-centralization dependency CoW and Uniswap do not have.

---

## 2. Findings (tiered by economic impact)

> The raw sweep produced 49 surviving findings across 10 dimensions; many describe the same root corridor from different angles. Below they are **consolidated** to avoid double-counting (per the verifiers' instruction), with cross-references to §3 where the corridor is fully modelled.

### CRITICAL

**[C-1 · Confirmed] The floor-only clearing-price corridor — loose-limit / market orders surrender up to ~99.99% of fair value.**
The settlement anchor enforces only the per-order floor (`order.sell_amount · price_num ≥ order.limit · price_den`, using the *full* sell amount — `clearing.ak:208`) and the pool only requires `k` non-decreasing (`spend.ak:106`). The clearing price is free in `[floor, AMM-price]`; underpaying the trader *raises* `k`, so the `k`-check never blocks the leak — it only caps the top.
- *Scenario (pool 1,000,000 TOKEN / 1,000 ADA, φ=0.3%; Alice sells 10,000 TOKEN; fair AMM-out = 9.8716 ADA):* a **tight 2% limit** ⇒ corridor `[9.800, 9.8716]` ADA, loss **0.725%**; a **market order `limit=1`** ⇒ Alice can be paid **1 lovelace** (or 0 via `num=1, den=s+1`), loss **~99.99%**, with ~9.87 ADA banked into the pool. Both validators executed at the worst price: floor binds at equality, `k`-check passes with positive slack, `mint==0`, payout pinned, pool absorbs the residual — **fully valid**.
- *Magnitude gradient:* ~0.016–0.72% for tight limits (trader-chosen, safe in practice); linear in looseness; ~99.99% at `limit=1`. The official builder rejects `limit ≤ 0` (`app/src/lib/chain/order.ts:108`), so the extremal is a **non-official-client / mis-set-slippage footgun**, not the official path — but it is *validator-legal*, so any third-party UI reproducing the `OrderDatum` format inherits the full leak.
- *Assumptions:* one-sided/imbalanced flow (a perfect CoW net banks nothing — see §2 Low/netting); realized extraction conditional on solver-LP overlap (a non-LP solver is *indifferent*, not necessarily fair — §3.4).
- *Benchmark:* CoW competes this surplus back to users via its auction objective; on Uniswap a slippage limit is a **ceiling that aborts**, never an execution price — so for a loose-limit deep-pool order **plain Uniswap strictly beats floor-only ShaSwap**. BLUEPRINT §5.2.5's "never worse than a plain AMM" is true only against the order's *own limit*, **false against the AMM curve**.
- *Mitigation:* implement the deferred §5.2.7 best-response / Trading-Rule-S check (pins the price), **or** a cheaper oracle-free on-chain *upper* per-order price-band co-derived with the existing `k` machinery; app-side, hard-cap slippage, never emit a true market order, and surface effective-vs-fair price.

### HIGH

**[H-1 · Confirmed] The tip auction structurally cannot discipline the corridor (latency-not-quality — the decisive CoW gap).**
`tip_taken = floor(tip · f / sell)` is provably independent of the clearing price (`clearing.ak:188`). Solver competition operates on tip-take and latency — orthogonal to execution quality. A rival cannot underbid on *price* to win an order's business; there is no on-chain objective ranking solutions by trader surplus. The latency race actively *favors* the extractor (an LP-solver has higher willingness-to-pay for block inclusion). *Mitigation:* a quality dimension in selection (the §5.2.7 check makes it moot by shrinking the corridor). *This is the single decisive difference from CoW.*

**[H-2 · Confirmed/Likely] Extraction is realized through solver-LP overlap; fair pricing is an unenforced off-chain assumption, not a chain guarantee.**
A θ=0 solver captures none of the banked surplus (tips are price-invariant) and is *indifferent* — but indifference does **not** imply fair pricing (a "maximize pool `k`" heuristic, or the first valid price found, shaves every trader with zero collusion). Safety therefore rests **entirely on the reference batcher's price-selection rule**. A solver holding θ of circulating LP captures θ·surplus; the "meaningful harvest" threshold is **~10% of LP for a market order**, >100% (impossible) for a tight 2% limit; a self-bootstrapped pool (θ→1) recaptures the *entire* corridor. *Residual the chain cannot see:* an LP can bribe a non-LP solver off-chain to clear unfairly. *Note:* the spec's claim that "the batcher gains nothing by under-filling" (`spec/lp-intents.md`) is **false for an LP-solver** and must be scoped to non-LP solvers. *Mitigation:* verify what price the Rust reference batcher actually picks (load-bearing); shrink the corridor on-chain.

**[H-3 · Confirmed] Single pool UTXO ⇒ per-block natural monopoly; entry caps tip rent, not corridor rent or inclusion control.**
At most one settlement per pool per ~20 s block, won on latency. The winner unconditionally monopolizes **batch composition** (which floors bind), **inclusion/exclusion** (cheap targeted censorship ~0.5 ADA/block, only delayed recourse — eUTXO can't include concurrently), and **timing** (wait for imbalance to widen the corridor). Decentralization here is a **contestability** property (anyone *can* enter), not a **concurrency** property (many cannot win the same block). *Mitigation:* the §5.2.7 quality objective removes the large prize that justifies latency investment; sharding (n>1) splits the monopoly but reintroduces price dispersion; ship client-side self-solve to lower the entry barrier.

### MEDIUM

- **[M-1 · Confirmed] Asymmetric corridor edge.** On an imbalanced batch the corridor's upper bound is set by `k`-feasibility (often *below* the buyer's floor), and depressing the heavier-side payout simultaneously inflates `k`, so a solver-LP's profit-max price is always the net-residual side's floor. *Worked: a sell-heavy batch corridor `[0.800, 0.996]` ADA/TOKEN, 19.7% of the seller's proceeds at solver discretion.* Fix: §5.2.7 / app-side tight floors.
- **[M-2 · Likely] Congestion turns tips into a priority-gas-auction.** On-chain nothing constrains composition beyond per-order floors. The reference batcher's tip-blind selection is an *unenforceable* Schelling point a tip-sorting fork strictly beats; under sustained inflow exceeding achieved per-block throughput, default-2-ADA orders are deprioritized and rest. *2 ADA is "safe" only at low load.* Fix: dynamic recommended tip from observed clearing latency; optional enforced inclusion-fairness in a future revision.
- **[M-3 · Confirmed] LP intents cannot amortize the fixed fee, and the precheck floor is ~3× too low.** Each LP intent is its own pool-spend (~0.42–0.46 ADA real fee), but the batcher precheck rejects only below `min_fee_b` (0.155 ADA) — so an intent tipped in `[0.155, ~0.46]` ADA passes the precheck, builds, then **silently fails the post-build gate and rests**, with no reclaim-to-underlying backstop. Fix: set the precheck and dApp LP-tip recommendation to the real single-tx floor (~0.50 ADA), hard-warn below it.
- **[M-4 · Likely] Single-UTXO winner is sole composer/timer + JIT-LP amplifier.** A derivative of C-1 but with genuinely new levers: the block winner can **exclude the one tight-limit order that would pin price near fair**, and **wait for imbalance to widen the corridor**. Belongs in the §8 threat model (currently only "self-dealing solver clears at floor" is listed). Fix: §5.2.7 kills it at the root.
- **[M-5 · Confirmed] Static fee + λ=1 + no oracle under-covers convex tail LVR.** Break-even needs φ ≥ jump/2, so 0.30% covers only ≤0.6% single-block moves; a +3% block recovers ~20% of its LVR. ~**1–5%/yr of pool value** uncompensated tail LVR on active/volatile pairs. Uniswap-v2-parity; the marginal weakness is **immutability** foreclosing dynamic-fee / concentrated-liquidity / λ<1 remedies. Fix: per-pool fee guidance (seed volatile pairs high in the 5% band); future variance-tracking fee from the pool's own clearing history or PA-AMM λ<1.
- **[M-6 · Confirmed] The corridor is an undisclosed trader→LP cross-subsidy.** Model-independent core: floor-only execution can pay a loose-limit trader *strictly less than plain Uniswap* (e.g. 90,000 vs 90,661 USDC, 0.66% worse), accruing to LPs as compensation *beyond* the stated fee. Inflates apparent LP yield; shrinks to ~0 under §5.2.7. *Do not market corridor-inflated APY.*
- **[M-7 · Confirmed mechanism / Suspected exact break] Cold-pool single-order tip must self-cover the whole fee.** With no orders to net against, a lone order self-finances the full ~0.22 ADA single-order settlement fee; below it, the order rests (reclaim still works). The same order is viable hot (~0.026 ADA/order amortized) and dead cold — the definition of a cold-start trap. The 2-ADA default clears but is a ~2% early-adopter overpay tax on small trades. Fix: negative-margin launch subsidy on canonical pools (documented, time-boxed); ship self-solve.
- **[M-8 · Likely] Residual-only fee ⇒ LP yield tracks imbalance, not volume.** A well-netted pair earns 0–~50% of the equivalent Uniswap gross fee (net/gross), while bearing the same λ=1 LVR. *Well-aligned* (arb pays, benign CoW flow doesn't) but a structurally thinner revenue base than every benchmark. Reframe: target protocol-owned/strategic LPs, not mercenary yield farmers; show realized residual yield, not gross-implied APR.
- **[M-9 · Confirmed] Cold-start needs a loss-making seeding+batcher operator — contradicting "no operator, runs forever."** Holds for the *validators* and a *warm* system; bringing a pair from zero requires a seeder at capital risk + batchers near/below break-even. No rational permissionless actor does this; the project bootstraps as a de-facto privileged operator. *Claims-honesty gap, not a fund risk.* Fix: state the boundary plainly in BLUEPRINT/CLAUDE.md; time-box and publish the bootstrap subsidy.
- **[M-10 · Confirmed gap / app-gated] `limit==0` market order → near-total loss.** The extremal of C-1; received can floor to **0** (the L-02 positive-price fix does not bound it). App-gated (`order.ts:108`) and BLUEPRINT defines "market" as a *loose slippage bound* (positive limit), so it is a non-official-client footgun. Fix: builder already translates "market" to `fair·(1−tol)`; if validators are revised, add a price-within-X-bps-of-`k`-marginal check.
- **[M-11 · Likely] Lived liveness depends on an aligned operator subsidizing the unfunded periphery.** "No mortal dependency" is true of the validators, not the lived protocol: a running batcher, the frontend (the only order builder — no client self-solve), and the data index are all unfunded. DEX-wide break-even is ~10 settlements/day (easily cleared with any traffic), so the real risk is **cold-start + the frontend/data layers that no tip level funds**. If the single operator of app.shaswap.org stops, non-experts have no builder. Fix: ship self-solve + a static/self-hostable + IPFS-pinned frontend; name a funded launch operator.

### LOW (selected, grouped)

- **Corridor facets:** the valid price is a closed *interval* not a point (documented design decision, magnitude trader-controlled); omitting the batch-cfmm Best-Response axiom *is* the corridor (the paper's JPD/no-front-running theorem does **not** transfer to v1); the LP-intent path carries the *same* corridor (withdraw ≥ min_a/min_b, deposit ≥ min_shares; under-fill donates to remaining LPs, solver captures only θ — so the incentive-compatible play is full fulfilment, making this the soundest corner).
- **Netting:** on a *perfect* CoW net the corridor is a pure trader↔trader transfer (pool gains nothing) the solver allocates anywhere in the floor overlap — exactly the surplus CoW returns to users.
- **MEV residuals:** resting public limit orders are free options to arbitrageurs (option value exceeds the 2-ADA tip within one block at σ=80%); first-valid-wins rewards SPO/relay proximity — a centralizing flywheel on *who* extracts (not custodial; §8 holds).
- **LP economics:** first-deposit inflation/donation attack is **adequately bounded** (Uniswap-v2-equivalent; attacker loses ~2× the donation, victim residual <0.05%); residual-only fee is **well-aligned** with the loss source (arb pays) but deletes the gross-volume cushion.
- **LP-intents:** solver-LP can fill withdraws/deposits at the floor and bank the residual to remaining LPs; withdraw-reclaim returns **LP tokens not underlying** — recourse during a total solver outage on a hot pool is strictly weaker than for orders (you cannot escape the drawdown). *Cheap fix (`lp_intent` is NOT frozen): pin `released_a == floor(res_a_in·L/circ_in)` — the per-share backing already bounds the max, so pinning to it closes the corridor at ~zero ex-unit cost.*
- **Centralization:** per-block winner controls inclusion (delayed, not concurrent, recourse); thin visible margin selects *for* integrated solver-LPs and *against* the redundant independents liveness needs.
- **Bootstrap:** SAMM sharding (n>1) *strictly worsens* cold-start (depth ÷n, tip density ÷n, price-impact ×n, new cross-shard arb) — correctly defaulted to n=1; add a creation guard against premature shards. First-deposit `isqrt` floor and the default-tip tax are minor, well-bounded.
- **Griefing:** dust-spam alone is weak (the solver, not the spammer, picks composition); the real censorship lever is *being* the winning solver. Proportional-tip rounding favours the user and pays full tip at f=1.

### INFO — what ShaSwap genuinely gets right (confirmed)

- **Intra-batch sandwiching is unconditionally eliminated** — one uniform price per single-shard batch leaves no orderable position to exploit. The decisive, real win over Uniswap mempool MEV and incumbent BEV.
- **Tip-only take blocks direct reserve/LP extraction** — the dual-pin (owner payout + full pool-output) + `mint==0` + ledger conservation force the batcher's net to `funding + tip − fee`; beyond the corridor there is **no** value-extraction path.
- **JIT liquidity is structurally penalized** — serialized pool-spends, no atomic deposit→settle→withdraw wrap, ≥3 blocks of inventory risk; good for honest passive LPs.
- **Fixed-cost amortization makes batching self-reinforcing** at low/moderate load (marginal ~0.026 ADA/order; the break-even gate is the right rule).
- **The core is genuinely cost-free and self-sustaining** — the on-chain validators have zero ongoing operating cost; the sustainability problem is confined to the (smaller) periphery.

---

## 3. The Validity-vs-Optimality Analysis (THE CRUX)

This is the load-bearing economic finding. It is *not* a security flaw — the contracts correctly enforce what they claim — it is a mechanism-design gap: **the set of valid clearings the chain accepts is strictly larger than the set of *fair* clearings, and every chain-paid incentive is indifferent across that gap.**

### 3.1 The solver as a constrained profit-maximizer

A solver building a single-shard settlement chooses a uniform rational price `p = price_num/price_den` and per-order fills `f`. The *only* constraints the chain imposes (verified against `clearing.ak` and `spend.ak`):

- **Positivity / well-formedness:** `price_num > 0`, `price_den > 0`, `asset_a ≠ asset_b`; every S-tagged input parses as a valid order bound to the spent pool's real pair/NFT.
- **Per-order FLOOR (the key one):** for a seller of `asset_a`, `sell_amount · price_num ≥ limit · price_den` — **using the full `sell_amount`, not `f`**, so partial fills don't tighten it and a market order (`limit→0`) waives it for any positive price.
- **Exact payout pin:** `received = floor(f · price_num/price_den)`, owner output pinned exactly, stake read from the datum; `mint == 0`; pool absorbs exactly the net residual.
- **Pool `k`-non-decreasing, residual-only fee:** `eff_a·eff_b ≥ res_a_in·res_b_in·fee_den²`.

The chain pays the solver **only the posted tip** `T = Σ floor(tipᵢ·fᵢ/sellᵢ)` — **independent of `p`**. If the solver holds fraction θ of circulating LP, value it banks as higher `k` returns to it as share appreciation worth `θ · banked`. So its price-dependent payoff is:

```
Π(p) = T (const in p) + θ · Banked(p),   Banked(p) = Σ (p_fair_i − p)·q_i  ↑ as p ↓
```

Banking is monotone — depressing the seller's payout simultaneously *raises* `k` — so the solver-LP maximizes by clearing at the **worst-for-user end of the feasible interval**.

### 3.2 Point or interval?

**A closed interval, not a point.** Lower bound = the binding order floors (the trader's own `limit`); upper bound = the price at which `k` stops being non-decreasing, which is *exactly the Uniswap-v2 fee-on-input execution price* (verified two ways — binary search on the `spend.ak` constraint and the closed form `R_b·dx(1−φ)/(R_a+dx(1−φ))` — they coincide, because the residual-only-fee `k` *is* the v2 curve). Nothing in `clearing.run` selects the fair point inside the interval; it explicitly does **not** check best-response. This is precisely the batch-cfmm.pdf **Best-Response axiom** that v1 omits — ShaSwap implements three of the four axioms (Conservation, Uniform Price, Non-decreasing trading function) and replaces the fourth with the weaker per-order floor. (The axiom alone does not pin a unique price — the paper's equilibria can be non-unique — it is the Trading-Rule-S / Pareto selection layered on top that picks the trader-best edge; v1 gives the price-taking half via the exact-price payout but omits the quantity best-response and the equilibrium selection.)

### 3.3 Worked batch — solver-optimal vs socially-optimal

**Pool:** `R_a = 1,000,000` TOKEN, `R_b = 1,000,000,000` lovelace (1,000 ADA), φ = 0.3%; fair mid = 1,000 lov/token. Alice sells `s = 10,000` TOKEN.

- **(a) Tight 2% limit** (`limit = 9,800,000`): floor binds at p=980.0 → payout **9.800 ADA**; `k`-bound (AMM execution) = **9,871,580 lov ≈ 9.8716 ADA**. Corridor `[980.0, 987.158]`. Alice's loss vs best-feasible = **0.0716 ADA = 0.725%**. Both validators executed at the worst price `(num=980, den=1)`: floor binds at equality, `k`-check `1.00007×10²¹ ≥ 1.0×10²¹` passes, `mint==0`, payout pinned, pool absorbs `(+10,000 TOKEN, −9,800,000 lov)`. **Both pass — the corridor is genuinely free, and the floor end is strictly below a plain Uniswap-v2 swap.**
- **(b) Market order** (`limit = 1`): the floor is satisfied for any positive price; Alice can receive **1 lovelace** (or 0 via `num=1, den=s+1`). The `k`-check *improves* as she is underpaid. Corridor `[≈0, 987.158]`; loss **~99.99%**; ~9.87 ADA banks into the pool.

The same corridor exists symmetrically on the **LP-intent path**: a withdraw releases ≥ `min_a/min_b` but ≤ the per-share-backing cap (the fair proportional amount); surplus on under-fill donates to remaining LPs (verified — the backing pins the *max* exactly, so surplus can never route to the solver's direct payout, only its θ-share).

### 3.4 The solver-LP harvest as a function of LP share

Banked surplus accrues **pro-rata to all circulating LP**; a solver holding θ captures θ·banked:

| LP share θ | Tight-limit batch (banked ≈ 0.072 ADA) | Market batch (banked ≈ 9.87 ADA) |
|---|---|---|
| 0% (non-LP solver) | 0 (indifferent) | 0 (indifferent) |
| 10% | 0.007 ADA | 0.987 ADA |
| 50% | 0.036 ADA | 4.94 ADA |
| ≈100% (self-bootstrapped pool) | ~full | ~full |

"Meaningful harvest" threshold ≈ `1/surplus`: **~10% of LP for a market order**, >100% (impossible) for a tight 2% limit. Aggregate ≈ avg-tolerance × flow × θ × win-rate.

**Crucial honest caveat:** for a non-LP solver (θ=0) corridor choice is payoff-irrelevant — strictly *indifferent*. Indifference does **not** imply fair pricing (a naive "maximize `k`" heuristic or the first valid price found shaves every trader with zero collusion). **Safety rests entirely on the reference batcher's price-selection rule, not on the chain.** And the surplus is fundamentally a transfer *to all LPs* — the solver-LP captures only θ; the rest is a windfall to honest passive LPs. "The solver harvests it" is precise only at θ→1 (a self-bootstrapped pool whose creator runs the batcher — the maximally-exposed configuration).

### 3.5 Why the tip auction cannot compete it away

`tip_taken = floor(tip·f/sell)` is provably independent of `price_num/price_den` (`clearing.ak:188`; tested at p = 1/20, 1/2, 980 — all yield the full tip on a full fill). So first-valid-wins exerts **zero** pressure on price, and the latency race actively *favors* the extractor (higher willingness-to-pay for block inclusion). Orders are anonymous `OutputReference`s with no solver routing/reputation, so a user cannot steer future flow to a fairer solver.

This is **the decisive difference from CoW Protocol.** CoW's auction *objective* ranks solvers by trader surplus, so a solver that clears unfairly *loses* to one that clears fairly — competition prices the corridor to ~0. ShaSwap replaces the surplus objective with a latency objective, deleting the only force that would compete extraction away. Against Uniswap there is no corridor; for a *loose-limit* order against a deep pool, **plain Uniswap beats floor-only ShaSwap** (the user always gets the curve price; a slippage limit only aborts). BLUEPRINT §5.2.5's "never worse than a plain AMM" is true only against the order's *own limit*.

### 3.6 The precise residual being accepted

> *v1 guarantees each order execution no worse than its own posted limit, plus a non-decreasing pool invariant — but NOT fair-equilibrium execution. The uniform clearing price is free within `[order-floor price, AMM-k-preserving price]`. The surplus is transferred from loose-limit/market traders to LPs as higher `k`, captured pro-rata, disproportionately by an LP-holding solver, and is invisible to and uncompeted-by the tip auction. The harm is ~0 for tight-limit flow and unbounded-up-to-the-slippage-bound for market flow; realized extraction is conditional on solver-LP overlap and loose user limits, both mitigated only app-side.*

**The cure** is the deferred §5.2.7 Best-Response / Trading-Rule-S selection, or — cheaper and oracle-free — an on-chain **upper** per-order price-band co-derived with the existing `k` machinery. Until one ships, "MEV-resistant" must be narrowed to **"sandwich-immune / intra-batch-ordering-MEV-free,"** not "best-execution guaranteed."

---

## 4. LP-Return & Fee-Viability Model

### 4.1 P&L decomposition

From Milionis et al. (`lvr.pdf`), the hedged LP return for a constant-product pool (`ℓ = σ²V/8`):

```
Π_LP = φ·ResidualVol  +  θ·Σ(p_fair_i − p_floor_i)·q_i  −  (σ²/8)·V·Δt
       (A) residual fee     (B) corridor surplus (CRUX)      (C) LVR
```

| Term | What | Who pays | On-chain anchor |
|---|---|---|---|
| **(A)** | fee on the *net* imbalance after CoW netting — not gross volume | directional/arb flow | `pool_settle` fee on `pos(res_out−res_in)`; perfect net ⇒ 0 |
| **(B)** | gap between fair price and each loose order's floor, banked as `k`, accruing pro-rata to LPs (solver-LP captures θ) | loose-limit/market traders | floor uses full `sell_amount`; no best-response check |
| **(C)** | adverse selection — arbitrageurs realign at stale prices each block | LPs | λ=1 (full reserves exposed); no oracle |

**(A) and (C) are correlated by construction** — the residual reaching the pool *is* the arbitrage trade, so the fee is levied on exactly the loss-causing flow (well-aligned); the deletion vs Uniswap is the fee on benign CoW-netted volume (a pure LVR cushion v2 LPs kept). **(B) is a hidden cross-subsidy** that props up apparent yield and would shrink toward zero under best-response.

### 4.2 Worked numbers — calm vs volatile

**Setup:** pool 1,000,000 ADA / 1,000,000 token, V = 2,000,000 ADA-equiv, φ = 0.30%, ~20 s blocks.

Per-block break-even is **φ ≥ jump/2** (LVR convex, fee linear):

| Single-block move | LVR/block | fee = φ·in | fee/LVR |
|---|---|---|---|
| +1% | 12.44 | 7.48 | **0.60×** |
| +3% | 110.84 | 22.33 | **0.20×** |
| +5% | 304.92 | 37.04 | **0.12×** |
| +10% | 1,191 | 73.21 | **0.06×** |

→ φ = 0.30% covers single-block moves only up to **0.60%**.

| Regime | gross/day | netted | residual | ShaSwap fee/yr | LVR/yr | NET (fee−LVR) |
|---|---|---|---|---|---|---|
| **Calm** (σ=0.20) | 400,000 | 80% | 80,000 | 87,600 | 10,000 | **+77,600** |
| **Volatile** (σ=1.20) | 600,000 | 30% | 420,000 | 459,900 | 360,000 | **+99,900** (fee recovers only ~28% of LVR; apparent health propped up by the corridor) |

**Verdict:** sound for low-vol majors (over-charges the average ~90×); **structurally under-compensates the convex tail of volatile pairs** — Uniswap-v2-parity in kind, with **immutability** the marginal weakness (forecloses dynamic-fee / concentration / λ<1). Uncompensated tail LVR ≈ **1–5% of pool value/yr** on active pairs.

### 4.3 First-deposit inflation — is min_liq=1000 adequate?

**Adequate — Uniswap-v2-equivalent.** Worst case (`a=b=1001`, attacker holds 1 share): victim max loss ≈ one share's backing ≈ `2·reserves/circ` → asymptotically **≤0.05%** of the victim deposit; attacker net ≈ **−2× the donation** (captured by the 1,000 locked shares + the victim's own stake). `total_lp≈9.2e18` is irrelevant (circulating is value-derived). ShaSwap is slightly *stronger* than naive v2 (empty-pool creation, both-asset backing checked every action). The one constraint to surface to seeders: positive LP needs `isqrt(a·b) > 1000` (product > 1,002,001), and a few-hundred-ADA seed forfeits a couple percent to the lock until circulating grows. Residual surface: socially engineering a victim into a pre-inflated pool → app-side anomalous-backing warning.

### 4.4 Are LPs adequately compensated?

- **Calm/low-vol majors → over-compensated** (fee over-covers ~90×); APR will look low vs Uniswap — that's the feature (yield tracks imbalance, not turnover).
- **Volatile pairs, mostly tight-limit flow → under-compensated** (fee recovers ~28% of tail LVR; immutability forecloses remedies). Need a high per-pool fee or non-yield holders (POL).
- **Any pair with loose/market flow → over-compensated *at traders' expense*** via the corridor (term B can dwarf the fee). **Not earned yield** — a hidden, regressive transfer, exactly what best-response would return to users. Closing the corridor simultaneously fixes user-fairness **and removes the prop holding up volatile-pair LP yield**.

---

## 5. Parameter Recommendations

| Parameter | Current | Recommended | Robust / Fragile | Why |
|---|---|---|---|---|
| **On-chain fee bound** | `0 ≤ fee_num < fee_den` only | Keep loose on-chain; make app cap a hard, prominent rail + verified-pool list | Fragile (consumer protection), robust (design) | On-chain permits a 99%-fee immutable pool; only the official frontend (`MAX_POOL_FEE=5%`) guards it; danger is creation-time. |
| **Per-pool fee φ** | static, app default ~0.3%, cap 5% | **0.05–0.30% deep/majors; 0.30–1.0%+ volatile/illiquid**; seed volatile high in the band | Fragile (volatile), robust (stable) | LVR convex; 0.30% breaks even only on ≤0.6% block moves; immutable per pool forecloses v3/v4 remedies; ~1–5%/yr uncompensated tail LVR. |
| **`min_liq`** | 1,000 | Keep; recommend seed ≥ ~1,100/side (product > 1,002,001) | **Robust** | Uniswap-v2-equivalent; attack costs ~2× donation; victim residual <0.05%. Watch: small seeds forfeit a non-trivial % to the lock. |
| **`pool_min_ada` / `order_min_ada`** | 2 ADA each | Keep | **Robust** | Tracks min-UTXO with headroom; three ADA roles kept separate; only sensitivity is upward min-UTXO drift. |
| **On-chain tip floor** | absent (app default 2 ADA) | No on-chain floor; set dApp recommended tip = real single-tx fee + headroom (~0.50 ADA), not `min_fee_b`; load/vol-aware | Fragile (UX/liveness) | LP intents can't amortize (~0.42–0.46 ADA floor) → silent stranding window; congestion → PGA. 2 ADA "safe" only at low load. |
| **Batch cap** | doc claims ~40–50; **batcher uses 30 safe / ~34 ceiling** | Use 30 safe, 34 hard; **fix the doc down to measured**; rely on tx-chaining | Robust (with doc fix) | Typed-value tests under-count ScriptContext; chaining drains ~120 orders/pool/block. Qualitative behaviour invariant to the exact cap. |
| **λ (PA-AMM)** | deferred = 1 (full exposure) | Keep for immutable v1; **prioritize λ<1 + on-chain realized-vol fee for the next revision** | Fragile (LP-side), acceptable v1 | Biggest LP-economics weakness; disclosed and v2-equivalent; the cost is immutability. Needs mutable pool state (new datum field). |
| **Sharding `n`** | 1 | Keep; **never shard until a single shard saturates the ceiling**; app guard on shard #2+ | Robust as defaulted; latent footgun | Premature sharding: depth ÷n, tip density ÷n, price-impact ×n, new cross-shard arb; gives no LP exit guarantee. |

**Protocol-parameter drift:** the constants embed *current* Cardano economics into immutable code. Most acute: **min-UTXO drift** (2 ADA hard-coded — a hard fork above it bricks *new* entries, never traps funds); **ex-unit/cost-model drift** (the ~30-order cap degrades gracefully, but a pathological repricing pushing a 1-order settlement past the limit would dark the DEX); **fee-param drift** silently moves the tx-fee floor the absent on-chain tip floor relies on the app to track. Bottom line: hard-code as little Cardano-economic state as possible, derive fees/tips dynamically off-chain, and keep a documented migration plan for the 2-ADA constants.

---

## 6. Comparison Table

Verdicts from ShaSwap's perspective.

| Dimension | vs CoW | vs Uniswap v2/v3 | vs Minswap/SundaeSwap |
|---|---|---|---|
| **Intra-batch sandwich resistance** | Different trade-off (both kill ordering MEV; CoW also competes to fair) | **Strictly better** (uniform price kills mempool sandwiching) | **Strictly better** (removes the trusted batcher's reorder power, trustlessly) |
| **Cross-batch / solver MEV (corridor)** | **Strictly worse** (CoW's objective competes it to ~0) | **Strictly worse for loose limits** (floor-only can pay worse than the AMM curve) | Different (incumbents execute at curve price but via a trusted operator) |
| **Solver-selection objective** | **Strictly worse** (latency race vs surplus-maximizing quality auction) | Different (Uniswap has no solver) | Different (incumbents: one accountable batcher; ShaSwap: anonymous, unscored) |
| **Price improvement to users** | **Strictly worse** (guarantees only the order's own limit) | **Strictly worse for loose limits** (curve price is only an unguaranteed ceiling) | Different |
| **LP fee basis** | Different (both fee only the residual) | **Strictly worse for LP revenue** (residual vs gross) | **Strictly worse** (no token to subsidize; fees only imbalance) |
| **LVR handling** | Different (both oracle-free in core) | ~parity vs v2; **worse than v3/v4** (immutability forecloses remedies) | Different (immutable fee can't be tuned) |
| **Custody / trust** | Different (both non-custodial; ShaSwap has no governance/auctioneer) | ~parity (+ always-available reclaim) | **Strictly better** (no escrow to a trusted batcher) — ShaSwap's clearest win |
| **Censorship resistance** | **Strictly worse** (delayed, not concurrent, recourse) | **Strictly worse** (inserts a per-block gatekeeper) | **Strictly better in principle** if ≥2 honest batchers run |
| **Liveness dependency** | **Strictly worse** (unfunded periphery) | **Strictly worse** (no direct-swap path) | Different (incumbents' funded batcher is always-on but a chokepoint) |
| **UTXO contention for users** | **Strictly worse** | **Strictly worse** (hot-pool LP withdraw can lose the race indefinitely) | **Strictly better** (incumbents route around it — via the custody chokepoint) |
| **Cold-start** | **Strictly worse** (no AMM-fallback swap path; rational batcher skips cold batches) | **Strictly worse** (Uniswap executes the instant gas is paid) | **Strictly worse** (incumbents' funded batcher runs from order one) |
| **Funding / sustainability** | Different (CoW: protocol fee + token; ShaSwap: zero core rent, unfunded periphery) | Different | Different (incumbents fund operator + team via fees) |
| **Governance / upgradeability** | **Strictly better** (no admin/token/upgrade authority) | **Strictly better** | **Strictly better** (immutable, operator-free core) |

**Synthesis.** ShaSwap genuinely advances the state of the art on **trust and immutability** — the only design in the set that is simultaneously non-custodial, operator-free at the core, tokenless, treasury-free, and unconditionally sandwich-immune. But the "**batch auction like CoW**" framing is misleading: CoW's defining feature is a solver *auction whose objective is user surplus*; ShaSwap replaces that with a **first-valid-to-land latency race with no quality dimension**, so it inherits CoW's MEV-resistance *without* CoW's price-improvement. Honest one-line positioning: **"sandwich-immune and trust-minimized, but the solver is the privileged within-batch price-setter and users get their floor, not best execution"** — better than Uniswap's mempool MEV and incumbents' BEV, materially weaker than CoW on execution quality, and the gap closes only if the deferred §5.2.7 best-response check ships.

---

## 7. Open Economic Questions (resolve before mainnet)

Most-decisive first. Items 1, 2, 3, 5, 10, 12, 13 are all downstream of the **one root fork (equilibrium-vs-floor)**; if the #4 spike shows headroom and you implement best-response, they collapse together.

1. **Equilibrium-vs-floor: close the corridor on-chain (§5.2.7) or sign off as an accepted residual?** Propagates into ~10 findings. Resolve via (a) Trading-Rule-S coherence check (gated on #4), (b) a cheap on-chain upper price-band, or (c) an explicit signed-off residual with the magnitude table in the BLUEPRINT.
2. **Solver selection: keep first-valid-wins (latency), or add a quality/surplus objective?** This is *why* the corridor can't self-correct. Decide between best-response (makes quality moot), a commit-window quality auction (heavy, likely rejected), or accept latency and correct the "fair / never-worse-than-AMM" claims.
3. **`limit==0` / market-order handling: validator guard or app-only?** The extremal of the corridor (received can floor to 0). Add a cheap price-band guard, or formally accept it as a documented client-responsibility footgun (third-party UIs inherit it).
4. **The make-or-break ex-unit spike: real per-order cost, and headroom for a best-response check?** Gates #1a. Measure at N=1/10/30/34 and with a prototype best-response/price-band; also correct the BLUEPRINT's 40–50 down to the measured ~30/34. **Decide this first.**
5. **Fee-level guidance: is residual-only static fee + λ=1 + no-oracle adequate, and what φ for canonical/volatile pools?** Publish per-pool guidance (volatile near the 5% cap), consider a future variance-tracking fee or λ<1, and do not market corridor-inflated APY.
6. **Tip-floor / fee-cover semantics: prevent silently-stranded orders, especially LP intents.** Set the batcher precheck *and* dApp recommended LP-tip to the real single-tx floor (~0.50 ADA), hard-warn below it; the current precheck advertises a floor ~3× too low and there's no reclaim-to-underlying backstop.
7. **Periphery & dev funding: who pays for frontend/data/dev, named and resourced?** No protocol fee funds these. Name a committed launch operator + runway (team/Catalyst); sign off that periphery is voluntarily funded.
8. **Liveness backstop: ship client-side self-solve, and make "≥2 batchers" a launch requirement?** Plus a static/self-hostable + IPFS-pinned frontend so the order builder survives any operator quitting.
9. **Cold-start: seed the chicken-and-egg without re-introducing a privileged operator — and state the contradiction honestly.** Time-box and publish the bootstrap subsidy; add "never shard a sub-saturated pair" guidance.
10. **LP-intent corridor: pin released/minted to the exact proportional amount.** `lp_intent` is *not* frozen — pin `released_a == floor(res_a_in·L/circ_in)` (the backing already bounds the max) to close the corridor at ~zero ex-unit cost; correct the spec's false "no incentive to under-fill" claim (scope it to non-LP solvers).
11. **First-deposit seed minimum: recommended floor + surface the donation/dilution residual.** Publish ≥~1,100/side guidance and disclose the locked-LP fraction at small seeds; ship the anomalous-backing warning.
12. **Marketing-claim sign-off.** Restate each claim with verified scope: "sandwich-immune" not "MEV-resistant"; "no worse than your own limit" not "no worse than an AMM"; "operatorless validators, voluntarily-funded periphery" not "runs forever with no operator."
13. **Congestion tip dynamics: accept tips become a PGA under load, ship a load-aware tip signal.** Surface a dynamic recommended tip from observed clearing latency; stop documenting 2 ADA as unconditionally "safe."

---

## 8. Bottom line

ShaSwap is a **trust-minimization success and a price-discovery gap**. Its custody, immutability, and sandwich-immunity are real and, on Cardano, genuinely ahead of the incumbents. But it ships three of the four batch-auction axioms and replaces the fourth (best-response) with a per-order floor, while selecting solvers on **latency, not quality** — so it captures CoW's MEV-resistance without CoW's best-execution, and leaves a solver-chosen price corridor that is a hidden trader→LP transfer, worst for exactly the loose-limit/market flow that dominates retail.

The single highest-leverage decision is **whether to close that corridor on-chain** (best-response or an upper price-band), gated on the ex-unit spike (§7.4); everything else is app-side mitigation and honest re-scoping of the claims. Pre-mainnet / testnet is the correct moment to make that call, before the floor-only anchor becomes immutable.

**If only three things are done before mainnet:** (1) run the ex-unit spike with a prototype upper-price-band and decide §7.1; (2) make the app the load-bearing mitigation — tight default limits, never a true market order, real tip floors (orders *and* the higher LP-intent floor), anomalous-backing warnings; (3) pin the (still-mutable) `lp_intent` released/minted amount to the exact proportional value and re-scope the "MEV-resistant / never-worse-than-AMM / runs-forever" claims.

---

*Provenance: 66-agent adversarial workflow `wf_8bea9691-60c`, run 2026-06-05. Central finding mirrored in project memory `econ-corridor-finding.md`. This is an economic review; the on-chain code was separately audited (Rev 24) and is assumed to enforce what it claims.*
