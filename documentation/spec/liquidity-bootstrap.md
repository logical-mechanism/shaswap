# Liquidity bootstrap & first-deposit math

> How pools come into existence and get their first liquidity — and the math that must
> behave at the smallest real reserves. An immutable DEX with no liquidity at launch is
> dead on arrival, so day-one seeding is a go/no-go coordination task, not just polish.
> Source: BLUEPRINT §6 (LP model), [`constants.ak`](../../contracts/lib/shaswap/constants.ak).

## Pool creation is permissionless

Anyone may create a pool (a hyperstructure requirement). Each pool has its own
seed-parameterised one-shot mint policy, so its NFT/LP policy id is unique; the pool
*validator* is shared, so all pools sit at one pool address. Creation mints
`{NFT:1, LP:total_lp}` into a single **empty** pool UTXO (reserves = 0 ⇒ circulating
LP = 0). The creator seeds reserves with the **first deposit**, a separate tx (the
just-created pool can't be spent in the same tx).

Creating empty avoids the first-depositor donation quirk (pre-seeded reserves would be
claimable by whoever deposits first).

## First-deposit math (the `circ == 0` branch)

On the first deposit into an empty pool, LP minted to the depositor follows the
Uniswap-v2 rule:

```
lp_out = isqrt(amount_a * amount_b) - min_liq        (min_liq = 1_000, locked forever)
```

`min_liq` LP is sent to the unspendable mint-policy address so circulating supply can
never return to ~0 (bounds the first-depositor donation/inflation attack). Consequences
for **small** reserves:

- The product `amount_a * amount_b` must exceed `min_liq² = 1_000_000` for the depositor
  to receive **positive** LP. Below that, `isqrt(a*b) ≤ min_liq` and the first deposit
  yields 0 (or fails) — a degenerate seed.
- Recommended **minimum** first deposit: pick reserves so `isqrt(a*b)` is comfortably
  above `min_liq` (e.g. each side ≥ a few hundred ADA-equivalent), both to clear the floor
  with margin and to give traders usable depth. A dust-sized pool is technically valid but
  economically useless and confusing in discovery.
- ADA side also carries `pool_min_ada` (2 ADA) overhead that is **not** tradeable reserve;
  seed the *tradeable* amount on top of it.

A unit test pins this boundary (smallest reserves that still mint positive LP, and the
`min_liq` lock) — see the LP math tests in [`app/src/lib/chain/lp.test.ts`](../../app/src/lib/chain/lp.test.ts)
and the contract LP tests.

## Day-one bootstrap plan (operator coordination)

This is a coordination decision, not a protocol rule. For mainnet launch the operator
should:

1. **Seed a small set of canonical pools** first (e.g. ADA paired with one or two
   liquid, well-known tokens), each with a real first deposit clearing the math above and
   a **low fee** within the app cap (see [`economic-parameters.md`](economic-parameters.md)).
2. **Add them to the verified-pool list** (`app/src/lib/chain/verifiedPools.ts`) so the
   dApp badges them and traders have a trusted starting set amid permissionless discovery.
3. **Publish the bootstrap set** (pairs, fees, pool NFT ids) so the community can verify
   what's official and add their own pools alongside.

The exact pairs/fees/sizes are the operator's call at launch time; this doc fixes the
*process* and the *math constraints*, not the specific tokens.
