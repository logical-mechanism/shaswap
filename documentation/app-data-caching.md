# App data-access caching & polling — design note

**Status:** decided + implemented (Phase: *no-poll / manual-refresh*).
**Scope:** `app/` only. Does **not** touch the protocol, validators, or `BLUEPRINT.md` — the
app's choice of Blockfrost is an app-layer convenience that the data seam exists to make
swappable (the "no mortal external dependency" invariant is about the on-chain *core*, not
the website's read backend).
**Assumptions confirmed with the owner:** single long-lived server instance (`next start` on
one DigitalOcean container); keep Blockfrost (lightweight, pure front-end); freshness should be
*"snappy when it counts, relaxed when it can."*

---

## 0. Decision (chosen approach)

Rather than the adaptive *polling* design of §5, we removed background polling entirely and made
all refresh **user-driven** — the simplest thing that keeps this a pure front-end on a shared,
rate-limited Blockfrost key. Chosen over the cache/single-flight build:

- **No interval polling anywhere.** Removed the `setInterval` loops in `usePools` (15s),
  `usePoolUtxo` (15s), and the orders page (10s). Chain reads now happen on **page mount** and
  on an **explicit Refresh** only ⇒ an idle/backgrounded tab spends **zero** Blockfrost quota.
  Cost shifts from `users × time` to just **user clicks**.
- **Manual Refresh on every data view** — pools list (new ↻), pool detail / LP panel (existing
  ↻), pool-detail *not-found* (new ↻ for the post-create indexing gap), orders ("Refresh").
- **Price = live estimate + on-demand refresh.** The quote still updates as you type (it's
  computed from cached reserves — cheap), plus a ↻ on the rate line that re-scans reserves +
  re-quotes for the freshest price before you post.
- **Confirmation = manual.** A just-posted order / deposit shows **instantly** via optimistic
  local state (`recordPost`, the LP success banner); the user hits Refresh to pull the on-chain
  confirmation once it indexes (~20–40s). No "settling…" auto-poll.
- **No server-side cache changes.** The existing 6s `poolsCache` stays; we did **not** add the
  TTL-cache/single-flight layer of §5.1 (not needed once polling is gone — the request volume is
  now tiny and click-driven). It remains the obvious next lever if request volume ever warrants.
- **Unchanged + authoritative:** the tx build/submit path still re-resolves a fresh UTXO at
  submit, so no preview staleness can produce a bad tx.

The §1–§7 analysis + cost model below is retained as background (and the §5 cache/single-flight
design remains the documented fallback if a future need reintroduces polling or higher volume).

## 1. The problem

Blockfrost runs **server-side**, behind the `/api/*` seam, under **one shared project id**
(read only in `getDataProvider()`, never in the browser). So usage is **not** per-user — every
visitor's browser polls *our* `/api/*`, and each uncached read spends from *our* single quota.

> N users polling an **uncached** shared read ⇒ up to **N× Blockfrost calls** on one quota.

Blockfrost's tiers cap daily requests (free tier ≈ **50,000 req/day**, 10 req/s — confirm the
exact tier in use). So the question is whether request volume scales with **user count** (fatal)
or with **time** (fine).

## 2. Current state

The provider is a **persistent singleton** (`getDataProvider()` caches `cached` in module
scope; valid because we run one long-lived Node process). One read is cached; two are not.

| `/api/*` | provider method | Blockfrost call | cached? | polled by |
|---|---|---|---|---|
| `pools`, `tokens`, `quote` | `listPools` / `priceQuote` | `fetchAddressUTxOs(POOL_ADDR)` + per-asset metadata | ✅ `poolsCache`, **6s TTL**; metadata cached on success | `usePools` (15s) on `/`, `/pools`, `/pools/create`, `/pools/[id]`; `useQuote` computes from cached reserves (no extra call) |
| `orders` | `walletPositions(addr)` | `fetchAddressUTxOs(ORDER_ADDR)` | ❌ **uncached** | orders page, **10s while a pending order exists** |
| `tx/pool-utxo` | `resolvePoolUtxo(nft)` | `fetchAddressUTxOs(POOL_ADDR)` | ❌ **uncached**, and **redundant** with `poolsCache` | `usePoolUtxo` (15s) on `/pools/[id]` |
| `protocol-params`, `tx/evaluate`, `tx/utxo`, `pool/mint-inputs` | params / evaluate / resolve | various | ❌ uncached | **on tx build only** (user action) — not polled |

Both leaks (`orders`, `tx/pool-utxo`) scan a **shared** address (all orders / all pools) and
then filter in memory — so they are *exactly as cacheable as pools already are.* They just
aren't cached, so they scale linearly with users.

### Why pools are already safe but the leaks aren't
`fetchPools()` coalesces every pool/token/quote reader behind one 6s scan, so 1 user or 10,000
users cost the same. `walletPositions` and `resolvePoolUtxo` do a fresh Blockfrost scan on
*every request*.

## 3. The freshness floor: chain indexing lag

A crucial bound: **Blockfrost can't reflect a just-submitted tx until the chain indexes it
(~20–40s).** So:

- A server cache TTL of **~10–15s is invisible** — the data isn't meaningfully staler than
  reality, which already lags 20–40s.
- "Snappy when it counts" therefore is **not** about a near-zero TTL. It's about (a) showing
  optimistic local state instantly (already done: `recordPost` shows a pending order before it
  indexes; LP panel reloads on done), and (b) **polling faster while waiting** for the chain to
  catch up, then backing off.

## 4. Cost model (numbers)

Per-scan cost ≈ pages returned by `fetchAddressUTxOs` (100 UTXOs/page) + metadata (cached after
first). For now ~1 page each; the **per-scan** cost grows with the number of on-chain
orders/pools, **never with user count.**

**Today (uncached leaks), worst case:** `tx/pool-utxo` alone, with C users continuously on a
pool-detail page polling every 15s:
`C × (60/15) × 1440 ≈ C × 5,760` scans/day.
⇒ **~9 continuously-active pool-detail users exhaust the 50k/day free tier** (orders polling
adds more). This is the leak.

**After caching + single-flight, worst case (continuous active traffic, any user count):**

| read | TTL | scans/day (continuous) |
|---|---|---|
| POOL_ADDR (pools+quotes+pool-detail+create, **unified**) | 15s | ~5,760 |
| ORDER_ADDR (all orders-page users) | 10s | ≤ 8,640 (only while someone polls) |
| protocol params / cost models | ~epoch (or 5 min) | tens (≤ 288) |
| asset metadata | ∞ (cache on success) | ~0 ongoing |
| **total** | | **≈ 15k/day, user-count-independent** |

Comfortably under 50k/day **regardless of user count** — and far lower in practice once
background/idle polling is paused (§5.3). The cost is now bounded by **time and freshness, not
users.**

## 5. Proposed design — adaptive freshness

Two layers. The server layer makes user-count irrelevant; the client layer makes the *baseline*
track actual need ("relaxed when it can"), and read-your-writes makes it "snappy when it counts."

### 5.1 Server: cache + single-flight + tiered TTLs (the big lever)

A small generic helper (`lib/data/cache.ts`): a keyed **TTL cache with single-flight**
(in-flight coalescing). Single-flight matters as much as the TTL: when the TTL expires and a
burst of polls arrives together, they **share one** Blockfrost fetch instead of stampeding N
fetches.

```
ttlCache(ttlMs, key, fetchFn) -> Promise<T>
  - fresh entry within ttl  -> return it (0 Blockfrost calls)
  - in-flight fetch         -> await the SAME promise (0 extra calls)
  - stale/absent            -> one fetch, populate, fan out
```

Apply it inside `BlockfrostDataProvider`:
- **Unify the POOL_ADDR scan.** One cached raw `fetchAddressUTxOs(POOL_ADDR)`; both `fetchPools`
  and `resolvePoolUtxo` derive from it. Kills the redundant pool-detail scan entirely.
- **Cache the ORDER_ADDR scan.** `walletPositions` reads the cached raw scan, then filters by
  owner in memory. N orders-page users ⇒ 1 scan/TTL.
- **Cache protocol params / cost models** with a long TTL (params change ~per epoch; cost models
  rarely). These are tx-build reads; safe to cache for minutes.
- **Tiered TTLs** (defaults, tunable): POOL_ADDR 15s · ORDER_ADDR 10s · params 5 min ·
  metadata ∞. All sit at/under the indexing-lag floor, so caching adds no *visible* staleness.

**Correctness guardrail — never cache the tx-build resolve.** The *spend* paths
(`postOrder`/reclaim/deposit/withdraw/close) already **re-resolve a fresh UTXO at submit**
(`fetchUtxo`, `fetchPoolUtxo` in `lib/client/tx.ts`) and the validators reject stale inputs.
Caching is for **preview/display reads only**; the build path stays uncached and authoritative.
(`usePoolUtxo` feeds the preview; the builder re-fetches — already the case.)

### 5.2 "Snappy when it counts" — read-your-writes + fast-poll-while-pending

- **Optimistic local state** (already present) makes the user's *own* action feel instant with
  zero Blockfrost calls.
- After a successful submit, the client **refetches and polls fast** (e.g. ~5–8s) until the
  change is observed on-chain, then backs off. The orders page already does this ("poll 10s
  while pending"); generalize the pattern to the LP panel (poll while a deposit/withdraw is
  settling) and keep it bounded (a handful of extra scans per action, coalesced server-side).
- Because the server TTL is at the indexing-lag floor, "fast poll" surfaces the new state as
  soon as the chain has it — which is as snappy as physically possible.

### 5.3 "Relaxed when it can" — visibility-aware, idle-aware polling

A shared `usePolling(cb, { activeMs, idleMs })` (or extend the existing hooks):
- **Pause when the tab is hidden** (Page Visibility API) — most open tabs are backgrounded;
  this alone removes a large share of baseline polling. Refetch **once** on return to visible.
- **Slow/stop when nothing is pending** — pools table can poll at 30s (or only on focus); pool
  detail at 15s; orders stop entirely when nothing is pending (already close to this).
- **Jitter** the intervals (±10–20%) so independent clients don't synchronize into a stampede
  at the TTL boundary (single-flight already absorbs this, but jitter smooths the server).
- **Stop on idle** (no interaction for N minutes) and resume on interaction.

### 5.4 Optional: HTTP cache headers (defense in depth, low priority)
`Cache-Control: private/public, s-maxage=<ttl>, stale-while-revalidate` on the GET handlers so
*if* a CDN is ever put in front, it coalesces too. Today (no CDN in front of `/api`, Next 15/16
GET handlers are dynamic by default) this is marginal — the server cache is the real lever.
Defer unless a CDN/edge is added.

## 6. Alternatives considered (and why not now)

| Option | Verdict |
|---|---|
| **Server cache + single-flight (this doc)** | ✅ Biggest win, no new infra, keeps Blockfrost, ~3 small files. Cost becomes user-count-independent. |
| Shared cache (Redis/KV) | Not needed at one instance; would only matter if we autoscale (then per-instance in-memory still *bounds* cost — see §7). Adds a mortal dependency; skip until scaling demands it. |
| **Blockfrost webhooks → SSE/WebSocket push** | Eliminates polling, but needs a public webhook receiver + a client push channel + reconnect logic — heavier, more moving parts, and a stateful server. Revisit only if polling proves insufficient. |
| Self-host Kupo+Ogmios / **Dolos node** | The stated long-term direction; the seam makes it a one-file swap. Orthogonal to this work — caching helps regardless of backend and buys time. |
| Just raise the Blockfrost tier | Treats the symptom; cost still scales with users. Caching first, then tier for headroom. |

## 7. Risks & caveats

- **Multi-instance future.** The in-process cache coalesces per *instance*. If we autoscale to K
  instances, worst-case cost is K × the §4 numbers (still user-count-independent, just ×K). Fine
  for small K; a shared cache or sticky routing closes the gap later. Flagged, not solved here.
- **Per-scan cost grows with on-chain order/pool count** (pagination), not users. A very busy
  ORDER_ADDR ⇒ a few pages per scan. Still small vs 50k/day; monitor.
- **Staleness vs correctness.** Display can lag a TTL; the **build/submit path must not** — it
  stays uncached and re-resolves at submit (§5.1). No regression there.
- **Cache stampede at TTL boundary** — handled by single-flight; jitter is belt-and-suspenders.

## 8. Suggested rollout (phased — pending approval)

1. **Phase 1 (server, the 80%).** `lib/data/cache.ts` (TTL + single-flight); unify POOL_ADDR;
   cache ORDER_ADDR; cache params; tune TTLs. Add tests (the cache helper is pure-ish and
   node-testable; single-flight + TTL are unit-testable with a fake clock + a counting fetch).
2. **Phase 2 (client, the polish).** Visibility/idle-aware polling + jitter across
   `usePools` / `usePoolUtxo` / orders; fast-poll-while-pending generalized to the LP panel.
3. **Phase 3 (optional).** HTTP cache headers; a tiny `/api` request counter in logs to verify
   the model in production.

Each phase is independently shippable and keeps every gate green.

## 9. Open questions for discussion

1. **TTL values** — defaults above (POOL 15s / ORDER 10s / params 5 min) acceptable, or tune?
2. **Idle/hidden behavior** — fully pause hidden tabs (recommended) and stop polling after, say,
   5 min idle? Any screen that must keep live-updating in the background?
3. **Pools-table cadence** — relax `/pools` from 15s to 30s (it's a passive browse view)?
4. **Verification** — want a lightweight server-side request counter (log line per Blockfrost
   call) so we can *see* the before/after in the deploy logs?
5. **Scope sign-off** — implement Phase 1 first and review before Phase 2?
