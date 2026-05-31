# ShaSwap — Protocol Blueprint

> **Status:** Design blueprint / north star. No code yet. This document is the
> authoritative description of *what we are building and why*. Everything in the
> monorepo (contracts, batcher, website, docs) must trace back to this file.
> When a decision conflicts with this document, either change the code or change
> this document — never let them silently diverge.
>
> **Revision:** Rev 4 — 2026-05-31. (Rev 1: initial draft. Rev 2: threat model,
> known-risks split, user-limit floor + settlement trust anchor, batch
> amortization, honesty fixes from review #1. Rev 3: locked ADA-tip reward +
> withdraw-0 hook. Rev 4: review #2 — double-satisfaction rule, withdraw-0
> "checks every input" obligation, static fees, ADA triple-role accounting,
> first-LP inflation guard, `k`-not-stored, solve-cost honesty, generalized the
> oracle-mortality argument, axiom mapping; §3.2 malformed inputs → strict
> default-deny.)
>
> **⚠ Make-or-break risk:** on-chain verification cost per order (§13.1) bounds the
> whole thesis. Measure it before committing to the architecture.

---

## 1. One-sentence definition

**ShaSwap is a fully-decentralized, non-custodial, MEV-resistant batch-auction
DEX on Cardano (eUTXO), built as a hyperstructure — where untrusted solvers
compute uniform-price clearings off-chain and the on-chain validators *verify*
them — so no operator can ever custody funds, reorder trades, sandwich a user,
brick the protocol, or shut it down, and no trade is ever worse than a plain AMM.**

The name is a working name: *Sha* (sharded, after the SAMM sharding model) + *Swap*.
(Note the visual collision with SHA hashing; cosmetic only.)

---

## 2. Why this exists (the problem)

Every AMM/DEX on Cardano today runs into the same wall, and the current fixes
trade away decentralization to get around it:

1. **UTXO contention.** A swap must spend the pool UTXO and recreate it. Only one
   transaction can spend a given UTXO per block, so concurrent swaps against one
   pool collide as double-spends — only one survives, the rest fail and retry.
2. **Centralized batchers.** The shipping answer (Minswap, SundaeSwap, etc.) is an
   off-chain batcher that collects orders and applies them sequentially. The batcher
   is privileged: it chooses ordering, so it **can sandwich users (Batcher
   Extractable Value / BEV)** and is a liveness/censorship chokepoint.
3. **MEV / sandwiching.** Ordering-dependent execution lets whoever controls
   ordering extract value from users.
4. **LVR (loss-versus-rebalancing).** AMM LPs systematically lose to arbitrageurs
   who pick off stale pool prices. Cardano's ~20s blocks make stale-price loss
   structurally *worse* than on faster chains.

ShaSwap attacks all four, and refuses to buy throughput with centralization.

---

## 3. Governing principles (in priority order)

Tie-breakers. When two designs are otherwise comparable, the earlier principle wins.

1. **Decentralization first.** No privileged operator. No admin keys. No trusted
   sequencer. A feature that needs trust is either redesigned to be verified
   on-chain, or made an optional, clearly-labelled, fail-safe trade-off — never a
   mandatory core dependency.
2. **Hyperstructure & unbrickable.** Runs **for free, forever, with no maintainers,
   no upgrade authority, no operator**, and *nothing* can permanently break or lock
   it:
   - **No dependency on any mortal external entity.** The core functions in
     perpetuity on on-chain, self-contained data only — no oracle, indexer, server,
     or third party it cannot live without. **Oracle providers can and do shut down
     across DeFi**, so an immutable run-forever validator must not bet on any
     provider surviving. Anything needing an outside party is an isolated, opt-in,
     fail-safe pool *variant* (§5.4), never core.
   - **Strictness on every value-protecting path.** Well-formed state is handled with
     **default-deny**: a spend is rejected unless it satisfies the rules. The checks
     that protect value — conservation, the order↔output bijection, each order's own
     limit — never default to true.
   - **Malformed inputs are strictly rejected (default-deny).** A UTXO arriving with
     a missing/invalid datum has no recoverable owner (it could have come from any
     wallet or contract; every ownership guess is wrong in some cases), so there is
     no rule that could safely return it. The validator simply rejects it: such
     self-inflicted third-party sends are stranded, exactly as on every chain. **The
     protocol never *creates* malformed UTXOs**, so this only ever affects external
     mistakes — never protocol funds and never a well-formed user order (which is
     always reclaimable by its owner on signature, §3.3).
   - **No value path ever returns `True` for unparseable input.** We eliminate the
     single riskiest possible code path rather than carry it just to let a stranger
     sweep someone's dust. Each spent script UTXO is validated independently, so a
     malformed input can never contaminate the rest of a transaction.
3. **Non-custodial, always.** Funds are controlled only by the user's key and public
   validator logic. Every well-formed order is reclaimable by its owner on signature.
4. **Verify, don't trust.** The off-chain solver supplies the clearing (price +
   witnesses) in the redeemer; the chain only *checks* algebra. Anyone may produce
   it; nobody is trusted to. (For v1's cheap solve, the value of off-chain solving is
   **determinism + tx-size + not making the chain iterate**, not compute cost — §5.3.)
5. **Safety is structural, not economic.** Users are safe from theft and sandwiching
   by the validator rules, not by assuming anyone is honest or rational.
6. **eUTXO-native.** Determinism, local state, solve-off-chain/verify-on-chain. No
   account-model patterns needing global mutable state.
7. **Permissionless participation.** Anyone can trade, LP, create a pool, run a
   solver, or run a frontend.

---

## 4. Intellectual foundations

Synthesis of four recent results; the source PDFs sit alongside this file in this
folder.

| Source | What we take |
|---|---|
| **Augmenting Batch Exchanges with CFMMs** — Ramseyer, Goyal, Goel, Mazières, EC '24 ([arXiv:2210.04929](https://arxiv.org/abs/2210.04929), `batch-cfmm.pdf`) | Clear CFMM liquidity **and** limit orders together at a single **uniform price**. The paper's four batch-exchange axioms — **Asset Conservation, Uniform Prices, Best-Response for limit orders, Non-decreasing trading function** — map directly onto our §5.2 rules 1/2/4/3; ShaSwap is essentially those axioms turned into an on-chain validator. Plain constant-product is a member of the paper's **CLCP class** (Def 4.5), for which **Trading Rule S** (Def 4.3) yields a **rational, price-coherent** equilibrium (Thm 1.8) — cheap to *verify* on-chain. **JPD** (Prop 1.7) → no intra-batch front-running. *(Terminology verified against the PDF, p.5.)* |
| **SAMM: Sharded Automated Market Maker** — Chen, Vaisman, Eyal, '25 ([arXiv:2406.05568](https://arxiv.org/abs/2406.05568), `samm.pdf`) | **Sharding** into `n` independent pool UTXOs (no dispatch contract, no global state — natural for eUTXO) as a scaling lever; rational fee function in integer math. |
| **Automated Market Making and Loss-Versus-Rebalancing** — Milionis, Moallemi, Roughgarden, Zhang '24 ([arXiv:2208.06046](https://arxiv.org/abs/2208.06046), `lvr.pdf`) | **LVR** is the LP adverse-selection cost; proves curing it needs *external* price data (§5.6). |
| **Partially Active Automated Market Makers** — Ko, Feb '26 ([arXiv:2602.09887](https://arxiv.org/abs/2602.09887), `partially-active-amm.pdf`) | **PA-AMM `λ`**: expose only a λ-fraction of reserves per batch — an oracle-free LVR lever. |

**Key realization:** *batch clearing itself solves UTXO contention.* A settlement
clears many orders against a pool in **one** pool-spend. **Batching is the primary
contention/MEV fix; SAMM sharding is a secondary scaling lever**, not the foundation.

---

## 5. Architecture

### 5.1 On-chain objects (UTXO types)

1. **Pool UTXO** — reserves of A and B for one pair (one shard).
   - *Datum:* pair identity, shard index, **static fee rate** (low), LP-token policy
     id, optional PA-AMM `λ` + last-batch marker. **`k` is NOT stored** — the pool
     validator checks `reserveA_after · reserveB_after ≥ reserveA_before ·
     reserveB_before` from the UTXO's *actual* reserves, so there is no datum/reserve
     desync. **No external references** (oracle pools are a variant — §5.4/§5.6).
   - *Identity:* a unique pool NFT.
   - *Spend paths:* (a) **settlement** (§5.2); (b) **LP withdraw/deposit** — total,
     share-token-based, independent of fragile datum fields, so LPs can always exit.

2. **Order UTXO (intent)** — one order, locked by the **immutable order validator**
   (the trust anchor, §5.4).
   - *Datum:* owner credential, sell asset + amount, **limit / min-receive** (the
     user's own floor; "market" = a loose slippage bound), partial-fill rule, **ADA
     tip** (§7), optional deadline.
   - *Spend paths:* (a) **owner reclaim/cancel** on signature alone (well-formed
     datum); (b) **settlement** (§5.2).
   - Funds stay user-controlled until settled. **Non-custodial.**

3. **LP-position token** — minted on deposit (per-shard), burned on withdrawal.

4. **Settlement transaction** — spends one Pool UTXO + a set of Order UTXOs;
   produces the new Pool UTXO, one **uniquely-bound** owner-output per filled order,
   remainder UTXOs for partial fills, and the solver's ADA reward output.

### 5.2 The settlement validation rules

Accepted iff all hold. Runs **once per transaction** (§5.4) over a solver-supplied
witness — the validator checks algebra, never solves (Principle 4).

1. **Asset conservation.** Tokens in = tokens out; nothing minted/burned except
   intended LP tokens. **ADA is accounted in three distinct roles that must not leak
   into one another:** *traded-ADA* (when ADA is one side of the pair), *tip-ADA*
   (solver reward), and *min-ADA* (per-UTXO overhead). The solver takes **only** the
   posted tips.
2. **Uniform price.** Every order in the (single-shard) batch fills at one clearing
   price. → eliminates intra-batch ordering MEV / sandwiching.
3. **Pool invariant non-decreasing.** Pool validator checks `k_after ≥ k_before`
   from actual reserves (§5.1).
4. **Best-response for orders.** Each order gets the best-response trade at the
   clearing price, respecting its limit and partial-fill rule.
5. **Per-order floor.** Every order receives **at least its own stated
   limit/min-receive** — curve-agnostic (safe against any pool variant, §5.4),
   bounds any accepted clearing, makes first-valid-wins safe. Guarantees **never
   worse than a plain AMM**; netting surplus above the floor is upside (§7).
6. **No double satisfaction.** Each order is bound to **exactly one** owner-output
   via the order's unique **OutputReference** (`txid#index`, which Cardano guarantees
   unique — no per-order NFT needed). The settlement validator enforces an
   **injective order→output mapping**, so one output can never be counted toward two
   orders' floors. *(This is the canonical eUTXO settlement bug; it is closed here by
   construction.)*
7. **Surplus / equilibrium (intent; cost-bounded by §13.1).** To route netting
   surplus to *traders* not LPs, the clearing should be required to be the **true
   uniform-price equilibrium**. Whether that fits the ex-unit budget is open
   (§12.2/§13.1); else we fall back to the §5.2.5 floor (Uniswap parity) + a fixed
   split.

### 5.3 Solver model — first-valid-wins, fully permissionless

- **A "batch" is the orders a settlement includes**, bounded by tx size / ex-units.
  No global boundary, **no coordinator** — uniform price holds *within each
  settlement*. Excluded orders stay open.
- **Anyone can be a solver.** Reads open orders + the pool, computes a clearing
  satisfying §5.2, submits.
- **First valid settlement to land wins.** Competing settlements over the same UTXOs
  become invalid and are rebuilt next round.
- **Solve cost & solution theft — honest framing.** At **v1 scope** (limit orders
  against one 2-asset constant-product pool) the clearing is essentially a **1-D
  monotone root-find — cheap, near-closed-form.** Consequences: (a) **solver-solution
  theft** (a watcher/SPO copying the public witness and resubmitting with their own
  reward output) is **largely moot** — re-solving is trivial, so copying saves
  nothing; (b) off-chain solving is justified by **determinism + tx-size + not making
  the chain iterate**, *not* compute cost. Both the compute-cost justification and a
  real theft threat appear only at heavier scope (multi-asset, many shards,
  surplus-equilibrium) — see §13.2.
- **Batch-composition is the residual solver power.** The solver picks which orders
  to include, which affects the clearing price. **Bounded** by §5.2.5 (no user worse
  than their own limit); removed for surplus too if §5.2.7 holds. Stated, not hidden.
- **Censorship resistance.** An ignored user self-solves (or pays any solver).
- **SPO choice is bounded.** A block producer picks which valid settlement lands but
  cannot violate §5.2.
- **One shard per settlement in v1** (simplest). Multi-shard settlement is deferred —
  later it could *unify* cross-shard price (a feature mitigating §5.5).

### 5.4 Pluggable pools, the trust anchor & the once-per-tx validator

- **The order validator (and the settlement logic it enforces) is the immutable
  trust root.** Orders commit to its hash and can only be consumed in a settlement
  satisfying §5.2. This is the thing we can *never* change.
- **Pool variants plug in *underneath* the anchor.** The order/settlement layer is
  agnostic to a pool's curve (it enforces §5.2); **each pool validator checks its own
  invariant.** New curves (stableswap, PA-AMM, oracle-enhanced, am-AMM) are variants
  whose logic lives entirely in their own validator.
- **A malicious pool variant cannot rob users**, because users are protected by
  *their own limit* (§5.2.5) via the immutable order validator — not by trusting the
  pool. A trivial-invariant pool only governs its own opt-in LPs.
- **Amortization via a withdraw-0 staking validator.** The §5.2 batch checks run
  **once per transaction** in a single withdraw-0 staking validator (the settlement
  validator) that orders/pool *defer* to via a cheap O(1) "is the settlement
  withdrawal present?" check — not re-run per input. Withdraw-0 is chosen over a
  minting hook because the ledger forbids a zero-quantity mint (a minting hook would
  always emit a token to manage); a 0-ADA withdrawal is genuinely zero, idiomatic,
  no artifact. One-time ~2 ADA refundable stake registration at deployment.
- **It MUST validate every script input — no input may slip past.** The deferral is
  only safe if the staking validator **enumerates and accounts for every order and
  pool input** at the protocol addresses in the tx. Otherwise an unvalidated order
  could ride along inside a settlement. This is a hard invariant of the design.

### 5.5 Sharding (SAMM) — scaling lever (and its price-dispersion cost)

- A pair may be `n` independent Pool UTXOs (shards); default **`n = 1`**. **Capacity
  grows by deploying additional shard UTXOs** — under immutability you cannot mutate
  an existing pool's `n`; you add shards.
- Shard selection is **client-side and coordinator-free**; the SAMM rational fee
  keeps shards balanced and discourages splitting.
- **Honest cost:** with `n > 1`, each settlement spends *one* shard, so orders
  against different shards in the same window **clear at different prices** —
  "uniform price" holds *per-shard-settlement, not pair-wide* — reintroducing
  cross-shard dispersion/arbitrage. A real reason `n = 1` is the default.

### 5.6 LVR: cured vs. mitigated, and the oracle question (one canonical statement)

**The hard fact.** LVR is *by definition* the gap between the pool price and the
**external** market price; curing it *requires external price data*. A closed pool's
only native price source is the **arbitrageurs**, whose profit for importing the real
price *is* the LVR. **In a trustless system, LVR is the fee you pay for not having an
oracle.**

- **Sandwiching / BEV / intra-batch MEV — cured, trustlessly** by uniform-price
  batching (§5.2). The headline, and it is **unconditional**.
- **JPD nuance.** Uniform price kills sandwiching unconditionally. JPD's *stronger*
  identity (post-batch pool spot = batch price) holds at the **true equilibrium**
  (§5.2.7); under the §5.2.5 floor-only fallback the pool spot can diverge from the
  batch price.
- **LVR (inter-batch arbitrage) — only mitigated, trustlessly:** **PA-AMM `λ`** (cap
  per-batch exposure; default 1), a **low static fee**, and **batch cadence**.
  (Dynamic, volatility-responsive fees are deferred — they need a stateful datum
  accumulator that adds ex-unit cost (§13.1) and a batch-composition manipulation
  surface.)
- **Order-side free option** — a public resting limit order on a ~20s chain is a free
  option to arbitrageurs, and its limit price is visible. Levers: **deadline**, tight
  **limit**, **tip**. Acknowledged residual.

**Why no oracle in the core.** An oracle could *cure* LVR (quote near-market), but
providers are mortal (§3.2); baking a living oracle into an immutable validator
contradicts Principle 2. *(Stated once, here; other sections cross-reference.)*

**How an oracle may still be offered — a pluggable variant (§5.4), never core.** A
future oracle-enhanced pool variant could read an oracle UTXO as a **reference input**
(CIP-31) as a price band / tighter floor, subject to: **constraint never authority**
(can only protect a user; a manipulated oracle can at worst make settlements
*invalid* — recoverable liveness — never steal); and **graceful death** (oracle
absent/stale → fall back to trustless behavior; never brick; LPs always withdraw).

---

## 6. End-to-end lifecycle

1. **Provide liquidity.** Deposit A+B into a shard, mint LP tokens. The **first LP
   sets the initial ratio.** To prevent the first-depositor share-inflation/donation
   attack (ERC-4626 vector), a **minimum initial liquidity is locked** (first shares
   burned) and **share value is computed from datum-tracked reserves, not raw UTXO
   value**, so a direct token donation can't inflate it. Later deposits add at the
   current reserve ratio.
2. **Place order.** Wallet builds an Order UTXO (sell amount, limit/min-receive,
   partial-fill rule, ADA tip, optional deadline). Funds stay user-controlled.
3. **(Optional) Cancel.** Owner spends the Order UTXO back at any time, on signature.
4. **Solve.** Any solver reads open orders + a shard, computes a uniform-price
   clearing satisfying §5.2, submits.
5. **Settle.** First valid settlement lands: pool updates, each filled order's owner
   receives its uniquely-bound output (remainders for partials), LP value updates via
   reserves, solver receives posted ADA tips.
6. **Withdraw liquidity.** Burn LP tokens to redeem a share of the shard.

---

## 7. Economic design

- **Trading fee → LPs**, a **low static rate** (captured in reserves / share value).
- **Solver reward = ADA tips (no bespoke token).** Each Order UTXO posts a small ADA
  tip; settlement pays the included orders' tips to whoever submits. **Bounded**
  (only posted tips), **transparent**, **verified by conservation** (§5.2.1) — a
  solver collects at most the tips. An order whose tip is too low simply **rests until
  its deadline, then is reclaimed** (§5.1) — tip and deadline are the same liveness
  mechanism. The reward (ADA) is **independent of the once-per-tx hook**
  (withdraw-0, §5.4): the hook *verifies* the payout, it does not *produce* it; tips
  already sit in the orders. **No token is ever minted to pay solvers.**
- **ADA's triple role** (tip / min-ADA / traded side of an ADA pair) is separated in
  the conservation check (§5.2.1) so none leaks into another.
- **Surplus capture (the differentiator, §5.2.7).** The floor guarantees Uniswap
  parity; whether netting surplus reaches *traders* depends on requiring the true
  equilibrium, cost-bounded by §13.1. Explicit open decision (§12.2).
- **Partial-fill min-ADA.** One input (one min-ADA) → remainder UTXO **and** owner
  output, each needing its own min-ADA. Funding rule TBD (§12.4): user pre-funds for
  a bounded number of partials, or partials are capped.
- **No protocol rent, no treasury, no governance token** (Principle 2).

---

## 8. Threat model

| Attacker | Capability | Containment |
|---|---|---|
| Malicious / self-dealing solver | Chooses batch composition; places own orders; clears at the floor | Uniform price (§5.2.2) + each order ≥ its own limit (§5.2.5); own orders fill at the same uniform price. Worst case = Uniswap-parity; surplus leakage bounded by §5.2.7. |
| Solver-solution thief | Copies the public witness from the mempool, swaps reward output, resubmits | **Moot at v1** — re-solving the 1-D clearing is trivial, so copying saves nothing (§5.3). A real concern only at heavy solve scope (§13.2). |
| Double-satisfaction attacker | Reuses one owner-output to satisfy two orders' floors | Closed by §5.2.6 — injective order→output binding via unique OutputReference. |
| Colluding block producer (SPO) | Picks which valid settlement lands; can delay/censor | Cannot violate §5.2; censored user self-solves (§5.3). |
| Malicious pool variant | Trivial-invariant pool to rob takers | Users protected by their *own* limit via the immutable order validator (§5.4); the variant governs only its opt-in LPs. |
| Input-smuggler | Slips an unvalidated order into a settlement tx | §5.4 invariant: the staking validator must account for **every** script input — none may slip past. |
| First-depositor / donation | Inflates LP share value to round out small LPs | §6: minimum initial liquidity lock + shares from datum-tracked reserves. |
| Manipulated / dead oracle | Only in an opt-in oracle variant | Constraint-never-authority + graceful fallback (§5.6): at worst invalidates settlements (liveness); never steals; **core unaffected**. |
| Griefer | Malformed/datumless UTXOs at script addresses | Strictly rejected (§3.2): the malformed UTXO simply cannot be spent — only the sender's own funds are stranded, nothing else is affected. |
| Arbitrageur vs. resting orders | Picks off stale/visible limit orders | Order-side free option (§5.6); levers = deadline, tight limit, tip. Acknowledged residual. |

---

## 9. Decentralization summary

| Dimension | Status |
|---|---|
| Custody | **Fully decentralized.** Non-custodial by construction. |
| Brick / lock resistance | **Unbrickable** for protocol + well-formed user UTXOs (strict value paths; well-formed orders always reclaimable). Malformed third-party sends are strictly rejected/stranded — never the protocol's or a user's funds (§3.2). |
| Intra-batch MEV (sandwich / front-run) | **Eliminated** by uniform price (unconditional); JPD identity holds at equilibrium (§5.6). |
| Batch-composition / cross-settlement MEV | **Bounded, not eliminated** — capped by the per-order floor (§5.3). |
| Solver entry / liveness | **Permissionless** (first-valid-wins). No coordinator. Self-solve backstop. |
| Censorship | **Resistant.** Any honest solver (incl. the user) can include an order. |
| LP / pool / market creation | **Permissionless.** |
| Frontend | **Open.** |
| Governance / upgrades | **No admin keys, no governance token.** Scripts immutable by hash; new versions are new deployments. |
| External / mortal dependency | **None in the core.** Oracle-using pools are isolated, opt-in, fail-safe variants. |

---

## 10. Tech stack (locked)

| Layer | Choice |
|---|---|
| On-chain contracts | **Aiken** |
| Batcher / solver | **Rust** + **Pallas** (TxPipe) |
| Frontend | **TypeScript + React** + **MeshJS** |
| Data layer | Hosted provider (**Koios / Blockfrost / Maestro**) behind a **mandatory data-access abstraction**; self-hosted drop-in later (own indexer or a Pallas/TxPipe node such as Dolos). |

No module may call a specific provider directly — the abstraction is day-one.

---

## 11. v1 scope — "fairly complete," the public reveal

- Constant-product pools; arbitrary pairs; permissionless pool & LP creation.
- **Hybrid liquidity: limit + market orders, with partial fills.**
- **Uniform-price batch settlement; first-valid-wins solver; per-order floor;
  injective order→output binding (no double satisfaction).**
- **Non-custodial** orders with signature-only reclaim; **unbrickable** validators.
- **Settlement trust anchor + pluggable-pool architecture** (§5.4), withdraw-0
  once-per-tx validator that checks every input.
- **SAMM sharding supported** (default `n = 1`); **one shard per settlement**.
- **ADA solver rewards** (posted tips).
- **Oracle-free LVR mitigation:** PA-AMM `λ` (default 1) + **low static fee**.
- Reference **Rust/Pallas batcher**, **MeshJS React** frontend, data abstraction.

**Explicitly NOT in v1 / never in core:** any oracle dependency; order privacy
(intents and limit prices are public on-chain); cross-shard price unification;
dynamic/volatility-responsive fees (deferred, §5.6).

**Deferred (not rejected):** multi-asset (>2) single-batch clearing; multi-shard
settlement; cross-pair routing; self-hosted data node; dynamic fees; oracle /
stableswap / am-AMM pool variants.

**Never (by principle):** governance token, admin-controlled parameters, custody,
privileged operator, any mortal external dependency in the core.

---

## 12. Open design decisions

1. **Solver tip mechanics.** User-set + protocol minimum vs. fixed; datum encoding.
2. **Surplus-distribution rule & verification cost.** True equilibrium (§5.2.7) vs.
   floor + fixed pro-rata split — *gated by* §13.1.
3. **Batch/settlement size bounds** and order rollover.
4. **Partial-fill semantics:** remainder rules, integer rounding, min-ADA funding.
5. **Clearing-price representation:** exact rational encoding for bit-exact
   solve/verify.
6. **PA-AMM `λ` defaults** and the static fee rate.
7. **Sharding defaults:** launch `n`; SAMM fee parameters.
8. **Hosted data provider** to start with.

*Resolved:* reward = ADA tips; once-per-tx hook = withdraw-0; fees static & low;
double satisfaction closed by injective OutputReference binding; `k` derived not
stored; malformed inputs strictly rejected (no `True` branch).

---

## 13. Known risks & limitations (to measure / accept, not decide)

1. **⚠ On-chain verification cost — existential.** If verifying §5.2 fits only a few
   orders per settlement within ~14M mem / ~10B steps / ~16KB, the contention &
   netting benefits collapse toward sequential. **Estimate:** each filled order costs
   an **input *plus* its owner-output** (+ remainder + min-ADA + datums for partials),
   so size budget ≈ input + output(s) per order — the realistic ceiling is **single-
   to low-tens of orders**, lower than an input-only count, and requiring full
   equilibrium (§5.2.7) lowers it further. Still beats the sequential baseline of 1.
   **Action: spike-measure before committing.**
2. **Solver-solution theft at scale.** Moot for v1's cheap solve; if heavier scope is
   added (multi-asset, equilibrium), the public-witness copy attack becomes real and
   would need addressing (commit-reveal was rejected; alternatives TBD).
3. **Batch-composition MEV** — bounded by the per-order floor, not eliminated (§5.3).
4. **Surplus capture unresolved** (§5.2.7/§7): floor = Uniswap parity; whether netting
   surplus reaches traders depends on §13.1.
5. **Order-side free option** — resting limit orders leak optionality on a slow chain.
6. **Sharding price dispersion** — uniform price is per-shard, not pair-wide (§5.5).
7. **Partial-fill min-ADA** overhead and funding (§7).
8. **No order privacy in v1** — intents and limit prices are public on-chain.
9. **LVR is not cured, only mitigated** — accepted by design (§5.6).

---

## 14. Monorepo layout

```
shaswap/
├── README.md
├── CLAUDE.md               ← repo guide for contributors & Claude
├── MEMORY.md               ← project state / decision log
├── documentation/          ← this blueprint (source of truth) + papers + specs
│   ├── BLUEPRINT.md        ← the north star (this file)
│   ├── samm.pdf  batch-cfmm.pdf  lvr.pdf  partially-active-amm.pdf
│   └── spec/               ← (planned) datum/redeemer formats; formal §5.2 rules
├── contracts/              ← Aiken validators & policies (aiken.toml, lib/, validators/)
│   ├── order/              ← (planned) order validator (trust anchor) + reclaim
│   ├── settlement/         ← (planned) withdraw-0 once-per-tx validator (§5.2; checks every input)
│   └── pool/               ← (planned) curve-agnostic core pool + variants; NFT & LP policies
├── batcher/                ← standalone Rust + Pallas solver binary (permissionless role)
│   └── (planned) indexer · solver · submit
└── app/                    ← TS + React + MeshJS website (hosts the data-access abstraction)
```

`batcher/` is a **reference** solver so the role is genuinely permissionless.
`documentation/spec/` holds precise encodings once we pass blueprint stage.

---

## 15. Glossary

- **eUTXO** — Cardano's extended UTXO ledger model.
- **Hyperstructure / Unbrickable** — runs free, forever, no operator/upgrade
  authority; no protocol or well-formed user UTXO can lock; value paths strict.
- **CFMM / CPMM** — constant-function / constant-**product** market maker.
- **CLCP** — the batch-CFMM paper's "Concentrated Liquidity Constant Product" class;
  **plain constant-product is a member** (we do *not* use Uniswap-v3 concentrated
  liquidity). Verified in the PDF; Thm 1.8 / Trading Rule S apply to it.
- **Uniform price** — one clearing price per single-shard batch; the anti-MEV
  property (unconditional).
- **JPD** — Joint Price Discovery; post-batch pool spot = batch price. Holds at the
  true equilibrium; can diverge under the floor-only fallback (§5.6).
- **Double satisfaction** — the eUTXO bug where one output satisfies two orders;
  closed by the injective OutputReference binding (§5.2.6).
- **LVR** — loss-versus-rebalancing; needs external price data to *cure*; we
  *mitigate* (§5.6).
- **Per-order floor** — each order gets at least its own limit; curve-agnostic; makes
  first-valid-wins safe.
- **Pluggable pools** — settlement/order layers are curve-agnostic; new pool types
  deploy permissionlessly under the fixed trust anchor (§5.4).
- **Reference input** — CIP-31; read a UTXO's datum without spending it (a future
  oracle *variant* mechanism — not the core).
- **Solver** — untrusted, permissionless party that computes a clearing and submits a
  settlement; paid in posted ADA tips.
- **First-valid-wins** — the first on-chain settlement satisfying §5.2 wins; no
  coordinator.
- **Withdraw-0 validator** — a staking script triggered by a 0-ADA withdrawal; our
  once-per-tx settlement check (§5.4).
- **BEV** — Batcher Extractable Value; what centralized Cardano batchers extract and
  what ShaSwap removes.
- **Aiken / Pallas / MeshJS** — Cardano contract language / Rust Cardano library / TS
  off-chain & wallet SDK.
</content>
