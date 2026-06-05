# Spec — Batcher-fulfilled LP intents (deposit / withdraw via the solver)

> **Status:** DESIGN-LOCKED (this doc), Phase-1 contract implemented. The new
> `lp_intent` validator joins the immutable deployment set; the settlement anchor,
> order, pool, and pool_mint hashes are **unchanged** (`lp_intent` is an additive,
> self-contained tx, never folded into a settlement). Source of authority:
> BLUEPRINT §5.1 (UTXO types), §5.4 (anchor / responsibility split), §6 (LP model),
> §13 (residuals). Mirrors the owner-protection patterns of
> [`clearing.ak`](../../contracts/lib/shaswap/clearing.ak) exactly.

## Why this exists (the problem)

The pool UTXO is a **single one-spend-per-block serialization point**. Batching solved
contention for *swaps* — they aggregate into one settlement — but **not for LP actions**.
The direct LP path (`pool` validator `LpAction`,
[`spend.lp_action`](../../contracts/lib/shaswap/spend.ak)) is *mutually exclusive* with a
settlement (`pool.ak`: `LpAction -> !withdrawal_present(S)`), so a deposit/withdraw is its
own pool-spend that must **win a race** against the batcher for the pool UTXO. On a
highly-traded pool the batcher occupies the pool ~every block, so a human-built withdraw
is `BadInputsUTxO` and rebuilds forever. "LPs can always exit" then really means "LPs can
exit *quiet* pools."

**The fix:** an **LP-intent** path so deposits/withdrawals are fulfilled by the
permissionless batcher, *like orders*. On a hot pool the batcher is spending the pool
every block anyway, so it folds your tipped intent into that per-block pool-spend
sequence; on a cold pool the existing **direct `LpAction` path is kept as a fallback**.
The two are complementary across the activity spectrum.

## What it is — a new UTXO type and a new validator

A **LP-intent UTXO** sits at a new address whose payment credential is the (new,
**`S`-parameterised**) `lp_intent` validator and whose **stake credential is `None`**
(enterprise). The validator is parameterised by `S` so `Fulfill` can assert a fulfillment
is **never folded into a settlement** (the no-fold guard, below) — but the UTXO's stake
credential is still `None`, *not* `S`, so the settlement
anchor **never enumerates it** (it would try to parse it as an order/pool and break) —
this is a hard invariant (BLUEPRINT §5.4 enumeration is `stake == Some(Inline(S))`; an
enterprise address can never match). One fixed, discoverable address; the batcher scans
it, the app posts to it.

```
LpIntentDatum {
  owner:        Credential,          // VK credential; spends + reclaims (non-custodial)
  owner_stake:  Option<Credential>,  // payout stake half — Some => base addr, None => enterprise
  pool_nft:     AssetId,             // the pool this intent consents to (binds by NFT)
  action:       LpIntentAction,      // LpDeposit | LpWithdraw
  min_a:        Int,                 // withdraw floor: released asset_a >= min_a
  min_b:        Int,                 // withdraw floor: released asset_b >= min_b
  min_shares:   Int,                 // deposit  floor: minted shares  >= min_shares
  tip:          Int,                 // solver reward (ADA), the ONLY thing the batcher keeps
  deadline:     Option<Int>,         // POSIX ms; tx upper bound must be <= deadline
}
LpIntentAction  { LpDeposit, LpWithdraw }
LpIntentRedeemer { Fulfill, ReclaimLp }
```

Unused floor fields are set to 0 (a withdraw ignores `min_shares`; a deposit ignores
`min_a`/`min_b`). The flat shape mirrors `OrderDatum`'s flat encoding and keeps the
TS/Rust/Aiken encoders trivially in parity.

### Intent value (what the owner locks)

- **Withdraw intent** holds `L` LP tokens + `lp_intent_min_ada + tip` lovelace, where
  `L = the LP being redeemed` and `L >= 1`.
- **Deposit intent** holds `dA` of `asset_a` + `dB` of `asset_b` + lovelace. If a pool
  side is ADA, the lovelace simultaneously carries **traded-ADA (the deposit on that
  side) + tip + `lp_intent_min_ada`** — the ADA triple-role (§ below).

`lp_intent_min_ada` (= `order_min_ada`, 2 ADA) is an **app/batcher funding constant**, not
a validator-enforced floor: the validator pins the owner-output *value* exactly, and the
ledger's own min-ADA rule rejects an under-funded payout (so a too-small intent is simply
un-fulfillable and remains reclaimable — never a fund risk). It lives in the new
`lp_intent_types` module so `constants.ak` (imported by the frozen validators) is untouched.

## The fulfillment conservation argument (the crux)

A fulfillment tx is a **mini-settlement for one LP action**. Exactly two validators run:

- **Pool validator (`LpAction`)** — *unchanged*. Enforces per-share reserve backing
  (`res_out·circ_in ≥ res_in·circ_out` in **both** assets), NFT + datum continuity, no
  attached reference script, `mint == 0`, reserves ≥ 0, held in `[0, total_lp]`, and
  `circ_out ≥ min_liq`. This **bounds how much the pool may release** (withdraw) or how
  many shares it may release from held (deposit) — it protects *existing* LPs. It does
  **not** constrain where value goes.
- **LP-intent validator (`Fulfill`)** — *new*. Pins the **owner** payout exactly (the way
  [`clearing.ak` `check_one`](../../contracts/lib/shaswap/clearing.ak) pins owner
  outputs), so the batcher can take only the tip. It protects the *withdrawing/depositing*
  owner.

The two are complementary: the pool validator stops over-release (existing-LP dilution),
the intent validator stops under-payment (owner theft). Neither alone is sufficient;
together they are a complete mini-settlement.

### Shared preamble (both actions)

1. **Not a settlement — the no-fold guard (`!withdrawal_present(S)`).** `Fulfill` asserts
   the settlement withdraw-0 for `S` is ABSENT (this is why `lp_intent` is parameterised by
   `S`). It is **load-bearing for fund safety**, not hygiene: without it a tx could carry a
   settlement for some `S`-tagged pool P1 AND spend a **non-`S`-tagged** victim pool P2 via
   `PoolSettle` — which the anchor never enumerates, and whose `k`-check does **not** pin
   held LP — so a deposit `fulfill` would mint **unbacked** shares (reserves unchanged, held
   released) to the attacker, who then drains P2. With the guard the bound pool can only be
   spent via `LpAction` (PoolSettle needs the withdraw-0; ClosePool burns the NFT → no
   `pool_out`), so the per-share backing ALWAYS runs. *(Found by adversarial review of this
   validator before lock; mirrors `pool.ak`'s own `LpAction -> !withdrawal_present(S)`.)*
2. **Exactly one LP-intent input per tx.** `Fulfill` reads its own input by the spent
   `OutputReference`, learns its own payment credential, and requires exactly one input at
   that credential. This makes the single owner-output binding injective with no
   per-intent NFT and no `BoundDatum` (v1 = one intent per tx; see *Future* below).
3. **`mint == 0`** (defence-in-depth; the pool's `LpAction` already enforces it, and this
   is what guarantees the LP the owner receives/burns is *moved*, never conjured).
4. **Bind the pool by NFT.** Filter inputs/outputs to the unique holder of
   `datum.pool_nft` (NFT supply is 1, minted once — only the real pool holds it): exactly
   one `pool_in`, exactly one `pool_out`. Parse `pool_in`'s datum **only** to read the
   real `(asset_a, asset_b)` and assert `d.nft == datum.pool_nft` (binds the named NFT to
   the pool's self-declared identity — same minimal read the anchor does, §5.4). The LP
   token is `{policy: datum.pool_nft.policy, name: lp_name}`.
5. **Reserves** via `spend.reserve_of` (ADA side carves `pool_min_ada`; token side is the
   raw quantity) on `pool_in` and `pool_out`. **Held** via `asset_qty(·, lp)`.
6. **Deadline:** `tx`'s finite upper validity bound ≤ `datum.deadline` (reuses the
   `clearing.ak` `deadline_ok`/`finite_upper` pattern, reimplemented locally — those
   helpers are private in the frozen module and `clearing.ak` must not change).

### Withdraw fulfill

Intent holds `L` LP + (`min_ada + tip`) lovelace.

- `L = asset_qty(intent.value, lp)`, **`L ≥ 1`** (strict).
- **`held_out − held_in == L`** — the burned LP actually entered the pool's held balance
  (the batcher cannot pocket any of it, and a *settlement* — which keeps held constant —
  can never masquerade as a withdraw).
- `released_a = res_a_in − res_a_out`, `released_b = res_b_in − res_b_out`.
- **`released_a ≥ min_a`, `released_b ≥ min_b`** (owner floor) and `released_{a,b} ≥ 0`.
- **Exact owner payout pin** (value-transform, ADA-triple-role-safe):
  ```
  owner_val = intent.value
    |> add(lp, −L)                 // the LP went into the pool's held balance
    |> add(asset_a, +released_a)   // released reserves go to the owner …
    |> add(asset_b, +released_b)
    |> ada_add(−tip)               // … minus the tip the batcher keeps
  ```
  Require an output with `is_payout_output(o, owner, owner_stake)` (address
  `{owner, owner_stake}`, no ref script) and `o.value == owner_val`.

### Deposit fulfill

Intent holds `dA` of `asset_a` + `dB` of `asset_b` + lovelace.

- `circ_in = total_lp − held_in`, **`circ_in > 0`** — the **first deposit is NOT
  intent-fulfillable** (the creator seeds directly via the existing `LpAction` path; this
  avoids the `is_sqrt`/`MIN_LIQ`-lock first-deposit branch here).
- `shares = held_in − held_out` (= `circ_out − circ_in`, the LP released from held).
- **`shares ≥ min_shares`** (owner floor) and **`shares ≥ 1`** (strict — forces a real
  held decrease, so a settlement can never masquerade as a deposit).
- `dep_a = res_a_out − res_a_in ≥ 0`, `dep_b = res_b_out − res_b_in ≥ 0` (the pool gained;
  a "deposit" can't pull reserves out).
- **Exact owner payout pin:**
  ```
  owner_val = intent.value
    |> add(asset_a, −dep_a)        // deposited assets entered the pool …
    |> add(asset_b, −dep_b)
    |> add(lp, +shares)            // … owner receives the minted shares
    |> ada_add(−tip)
  ```
  Same `is_payout_output` + exact-value requirement.

Per-share backing in the pool validator caps over-minting; the owner floor + exact pin
catch under-minting (and any attempt to route the deposit to the batcher instead of the
pool — that would force `shares` from a non-existent held release and fail backing).

### Why the batcher nets exactly the tip (no global-conservation pass)

Let `funding` be the batcher's own inputs/change. By ledger value conservation
`Σ inputs = Σ outputs + fee`. With `owner_val` pinned and `pool_out`'s protocol assets
moved by exactly `(±released/dep, ∓held)`:

```
batcher take = (pool_in + intent + funding) − owner_val − pool_out − fee
             = funding + tip − fee
```
(verified by substitution for **both** deposit and withdraw). The batcher recovers its
funding and the tip, pays the fee, and **cannot touch reserves** (any reserve it pulls is
`released`, which is pinned to the owner) **or the LP** (`held` is pinned, `mint == 0`).
This is the same "pins + `mint==0` + ledger conservation ⇒ tip-only" structure that lets
`clearing.ak` skip an explicit global pass.

### ADA triple-role

If a pool side is ADA, the intent's lovelace mixes **traded-ADA + tip + min-ADA**. The
single value-transform disambiguates them with no special path, because `reserve_of`
carves `pool_min_ada` out of the pool's ADA side and the `released`/`dep` delta + the
`−tip` land on the owner-output's lovelace field, leaving exactly the preserved min-ADA.
Worked example — pair `TOKEN/ADA` (`asset_b = ADA`):

- **Withdraw:** intent `{L lp, (min+tip) ADA}` → owner `{released_a TOKEN, (min+released_b) ADA}`.
  Released ADA (`released_b`) reaches the owner, tip removed, min preserved.
- **Deposit:** intent `{dA TOKEN, (dB+min+tip) ADA}` → owner `{shares LP, min ADA}`. The
  traded-ADA `dB` enters the pool's reserve (`reserve_of` delta), tip to batcher, min
  preserved.

Token/token pools have no traded-ADA role; the lovelace is tip + min only. All three
cases are the *same* code path. See [`ada-triple-role.md`](ada-triple-role.md).

## Reclaim

`ReclaimLp` is **owner-signature only** (reuses the `spend.order_reclaim` pattern: the
owner must be a VK credential and sign). It returns the *intent* to the owner:

- **Deposit reclaim** → returns `asset_a` + `asset_b` (the would-be deposit). Fully
  trustless, equivalent to order reclaim.
- **Withdraw reclaim** → returns the **LP tokens**, *not* the underlying. This is the
  honest residual below.

## Honest residual — withdraw has no reclaim-to-underlying backstop (→ BLUEPRINT §13)

An order's reclaim returns the *exact asset the owner locked*, because an order never
mutates shared state. A withdraw-intent reclaim can only return the **LP tokens**, because
turning LP back into underlying *is* a pool mutation — and the pool is the contended UTXO
we are trying to route around. So **hot-pool LP exit reduces to the same
tipped-permissionless-solver liveness as orders**: you are guaranteed to get your LP back
on signature, but converting it to liquidity still requires *some* solver to fulfil the
intent (or the direct path to win the race on a quiet moment). This is consistent with the
design — permissionless solver liveness, no privileged operator — but **strictly weaker
than order reclaim**, and it is inherent (not an implementation gap): withdrawal mutates
shared pool state. Mitigations: a tight `min_a`/`min_b` floor (the app sets it near the
fair proportional amount), the standing incentive of the tip (the batcher gains nothing by
under-/non-fulfilling), and the always-available direct path on any quiet block.

### Surplus on under-fill (acceptable, documented)

Within the floor, a batcher *may* release slightly less than the fair proportional amount
(withdraw) or mint slightly fewer than fair shares (deposit) — the difference stays **in
the pool** (accruing to remaining LPs), never to the batcher (its take is tip-only). The
batcher therefore has **no economic incentive** to under-fill; an honest batcher releases
the full proportional amount. This mirrors the order path's floor-only surplus treatment
(§5.2.7 / §13.4). Unlike an order, a withdraw leaves **no remainder** (the LP is already
burned into held), so under-fill permanently donates the surplus to remaining LPs — the
reason the app sets a tight floor.

### Incidental pool assets (pinned — stricter than the direct path)

The frozen pool validator does not pin the pool's *incidental* (airdropped) assets or, for
a token/token pool, its overhead lovelace above the ledger minimum, so a direct-path
spender could sweep the sub-ADA overhead gap + any airdropped token. `fulfill` **does** pin
the pool output's full value (`pool_out == pool_in` shifted by exactly the reserve/held
deltas), mirroring `clearing.ak`'s pool pin — so a batcher can sweep **neither**. The
intent path is therefore **strictly tighter** than the direct `LpAction` path here. (This
hardening came from the pre-lock adversarial review, which flagged the unpinned sweep as a
low-severity residual; closing it on the new, non-frozen validator was cheap and correct.)

## Sharding is not a withdrawal-liveness lever

SAMM sharding (§5.5) = *n independent pools per pair* (distinct NFTs/state). An LP is bound
to one shard's UTXO, so sharding spreads *aggregate* load but gives an *individual* LP no
exit guarantee on their shard. LP-intents — not sharding — are the withdrawal-liveness
mechanism.

## Invariants to encode (checklist — all covered by `lp_intent_test.ak`)

- [x] Withdraw: `L ≥ 1`; `held_out − held_in == L`; `released ≥ min` (both); exact owner pin.
- [x] Deposit: `circ_in > 0`; `shares ≥ 1`; `shares ≥ min_shares`; `dep ≥ 0` (both); exact owner pin.
- [x] Batcher diverting released assets / minted shares to itself → owner pin fails → reject.
- [x] Over-release / over-mint beyond backing → **pool** validator rejects.
- [x] LP pocketed (`held_out − held_in ≠ L`) → reject.
- [x] Tip over-collection (owner gets less than pinned) → reject.
- [x] Wrong `pool_nft` / no pool input / malformed pool datum → reject (un-fulfillable).
- [x] Payout owner/stake mismatch, or ref script on payout → reject.
- [x] Deadline passed → reject.
- [x] First deposit (`circ_in == 0`) via intent → reject.
- [x] Two intents per tx → reject (one-input-per-tx guard).
- [x] ADA-side deposit & withdraw triple-role correct (both directions).
- [x] Reclaim by owner → ok; reclaim by non-owner → reject; withdraw-reclaim returns LP.

## Future — multi-intent batching

v1 fulfils **one** intent per tx (one LP action per pool-spend, chained by the batcher into
its per-block sequence — *chained, not folded*, BLUEPRINT principle). Batching N intents
into one pool-spend is a later optimisation; it would (a) replace the one-input-per-tx
guard with `clearing.ak`-style injective `BoundDatum` binding (owner-output ↔ intent
`OutputReference`) to keep double-satisfaction impossible, and (b) require the per-share
backing to hold for the *aggregate* held change, not per intent. Deferred.
