# Economic parameters

> Status: launch-gating. These values become **permanent at mainnet deploy** — the
> validators are immutable, so every constant below is locked forever. This doc records
> each value, why it was chosen, and how it behaves if Cardano protocol parameters drift.
>
> Source: [`contracts/lib/shaswap/constants.ak`](../../contracts/lib/shaswap/constants.ak),
> BLUEPRINT §5.2 / §6 / §7.

## The permanent on-chain constants

| Constant | Value | Role |
|---|---|---|
| `pool_min_ada` | 2_000_000 (2 ADA) | min-ADA carved out of an ADA pool reserve; never counted as tradeable liquidity (§5.2.1). |
| `order_min_ada` | 2_000_000 (2 ADA) | per-UTXO min-ADA for an order / remainder output. A `partial` order pre-funds 2×. |
| `min_liq` | 1_000 | permanently-locked LP (Uniswap-v2 style); bounds the first-depositor donation attack. |
| `total_lp` | 9_223_372_036_854_775_807 (i64::MAX) | full LP supply minted into the pool at creation; circulating = total − held. |
| fee bound | `0 ≤ fee_num/fee_den < 1` | the **only** on-chain fee guard (`mint.ak`, `spend.ak`). |

There is **no on-chain tip floor** and **no on-chain fee ceiling** — see below.

## Fee policy — "static, low fees" (§3 invariant)

On-chain, the validators only enforce `0 ≤ φ < 1` (`φ = fee_num/fee_den`). The "low"
half of the invariant is **not** enforced on-chain: pool creation is permissionless, so
without a frontend guard anyone could create an immutable, permanently-discoverable pool
with a predatory fee (e.g. 99%).

**Decision (Rev-pending):** the "low" bound is enforced **app-side**, not on-chain
(keeping the audited validators frozen):

1. The dApp's pool-creation builder rejects `φ` above `MAX_POOL_FEE` (**5%**, i.e.
   `fee_num/fee_den ≤ 1/20`). See `app/src/lib/chain/createPool.ts`.
2. The trade UI surfaces the pool fee prominently and warns on a high-fee pool.
3. A **verified-pool** surface (`app/src/lib/chain/verifiedPools.ts`) lets the UI badge
   known-good pools, giving permissionless discovery a trust layer.

This protects users of the official frontend. A user who interacts with a trap pool via a
*different* client is outside this guard — which is the correct, honest boundary for a
permissionless, immutable protocol. (Bounding the fee on-chain was considered and
deferred to avoid re-opening the audited, ex-unit-measured validators; revisit only in a
future contract revision.)

## Solver tip — no on-chain floor

The tip is the **only** solver reward (§5.2.1) and is fully user-chosen. There is no
on-chain minimum, and an untrusted reference solver rationally **skips** any settlement
whose tips don't cover the tx fee. So a too-low tip doesn't fail loudly — the order just
**rests, possibly forever**, until its deadline or the owner reclaims it.

**Mitigations (app-side):**
- `buildOrder` rejects a non-positive tip (a 0-tip order can never be picked up).
- The swap UI defaults the tip to a sensible **2 ADA** and cautions when the entered tip
  is below a recommended floor (so low-tip orders aren't silently stranded).
- The single-order worst case sets the floor: a 1-order settlement pays the whole tx fee
  (~0.2–0.5 ADA), so a tip comfortably above that guarantees pick-up even with no netting.

## Cardano protocol-parameter drift (immutable-contract risk)

The constants are fixed forever, but the ledger can change `coinsPerUTxOByte` (min-UTxO),
ex-unit prices/limits, and cost models via hard fork. Analysis:

- **min-UTxO (`coinsPerUTxOByte`).** Today an order/pool UTXO's real min-UTxO is well
  under 2 ADA, so `*_min_ada = 2 ADA` carries headroom. A future increase only strands
  UTXOs if real min-UTxO ever exceeds 2 ADA for these output shapes — far beyond any
  historical change. **Headroom: large.** If the ledger ever approached it, new orders
  would simply need richer funding; existing reclaim paths are unaffected (reclaim returns
  the full UTXO to its owner).
- **Ex-unit prices/limits & cost models.** The batch ceiling is **~40–50 orders**
  ([`ex-unit-spike.md`](ex-unit-spike.md)) against the current per-tx ex-unit limit. A
  *reduction* in the limit, or a costlier cost model, lowers the achievable batch size but
  does **not** brick the protocol — a solver just settles smaller batches (down to 1).
  Single-order settlement stays affordable with wide margin. **No upgrade needed to stay
  live; only throughput degrades.**
- **What would actually hurt:** only a change that made even a **1-order** settlement
  exceed the per-tx ex-unit limit would strand funds with no settle path (reclaim still
  works). That is not plausible under any announced direction; flagged here as the single
  protocol-drift scenario to watch.

**Conclusion:** the frozen constants are drift-resilient in the realistic envelope. The
batch ceiling is the only quantity that meaningfully tracks protocol params, and it
degrades gracefully (smaller batches), never bricks. Re-run [`ex-unit-spike.md`](ex-unit-spike.md)
after any hard fork that touches ex-unit pricing or cost models.
