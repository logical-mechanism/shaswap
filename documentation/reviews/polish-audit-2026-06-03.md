# Polish Audit Report

**App:** ShaSwap dApp (`app/`) — kawaii, mascot-driven ("Pip") non-custodial batch-auction DEX on Cardano
**Date:** 2026-06-03 · **Branch:** `app/polish-audit` (off `main` @ `31339da`, which includes the merged Pip redesign)
**Method:** Full manual read of every source file + a 9-dimension multi-agent review with adversarial per-finding verification (39 agents). Every finding below was checked against the actual code; invalidated/over-stated claims were dropped or down-graded and are noted as such.

**Build signals (measured):** `tsc --noEmit` ✅ clean · `eslint` ✅ clean · `npm test` could **not** be executed in this environment (active Node is v20.20.2; the test script needs ≥22.6 — see Finding P-3).

---

## Executive Summary

**This is a polished v1, not a prototype — and it's an unusually careful one.** The codebase shows real engineering maturity that most "v1-ready" DeFi front-ends never reach: a strict data-access seam (no provider SDK ever touches the browser), BigInt-exact money math with documented half-up rounding, fail-closed network gating, disjoint-collateral handling in every script spend, honest order-status semantics ("completed", not a fake "settled"), AbortController on every fetch, a deferred-setState effect convention applied consistently, and a genuinely cohesive design system (`globals.css` `.k-*` kit + a single reusable `Pip` mascot covering hero/empty/loading/success/error/toast states). The brand commitment is real and consistent.

It is held back from "polished" by a **small, concentrated set of real issues**, not broad rot:

1. **Two trust-critical swap-surface bugs.** The MAX/Half buttons silently break for any balance ≥1,000 units (comma formatting), and the headline "1 X ≈ Y" rate line is **decimal-unadjusted**, so it contradicts the "To" amount whenever a pair's tokens have different decimals (e.g. ADA↔a 0-decimal token).
2. **Accessibility is the weakest area by far (≈58/100).** There is **no visible keyboard-focus indicator anywhere**, and the custom token/slippage/wallet menus can't be closed or driven by keyboard. For a financial product these are launch blockers, not nice-to-haves.
3. **A few production-hardening gaps:** no `error.tsx`/`not-found.tsx`/`global-error.tsx` (the only unbranded surfaces in the app), a silent MockProvider fallback that would serve *fake* pools if a prod deploy is misconfigured, and the correctness-critical pure functions (`toBaseUnits`, the AMM/price math, tx assembly) have **zero tests**.

None of these touch the non-custodial guarantee or risk user funds (every failure path is fail-safe — a bad order is rejected, never silently mis-posted). They are squarely fixable in a focused pass: roughly **2 must-fix correctness bugs + 2 must-fix a11y fixes + ~6 should-fix items** before calling it production-ready.

---

## Score

| Category | Score | Note |
|---|---:|---|
| Code robustness | **82** | Excellent hygiene; docked for duplicated gating logic, missing double-submit latches on 3 handlers, no tx-build tests |
| DeFi correctness | **72** | Core floor/slippage/conservation math is correct & BigInt-exact; docked for the MAX-comma break, the decimal-unadjusted rate line, and preprod/preview ambiguity |
| UX polish | **80** | Great disabled-state labeling & honest copy; docked for swallowed errors + no retry on swap/LP/create |
| UI polish | **84** | Model design system; docked mainly for the missing focus ring (also counted under A11y) and minor tint/popover drift |
| Brand consistency | **86** | Genuinely strong and committed; docked for unbranded 404/error/loading + dead scaffolding SVGs + 2 sterile error banners |
| Accessibility | **58** | The clear weak point: no focus-visible, keyboard-inoperable menus, low-contrast micro-text, no skip link |
| Production readiness | **66** | No error boundaries, silent mock fallback, near-zero logging/analytics, beta MeshJS pin, test-runner footgun |
| **Overall** | **77** | **Polished v1.** A focused fix list — not a rewrite — gets it to production-ready. |

---

## Top 10 Fixes Before Launch

Ranked highest-impact first.

### 1. MAX / Half buttons silently break for balances ≥ 1,000 units
- **Severity:** High · **Area:** DeFi
- **Current issue:** `setFromAmount` sets the input via `formatUnits(...)`, which **comma-groups** the integer part (`format.ts:48`). That string (`"1,000"`) is fed back into `toBaseUnits`, whose regex `/^\d*\.?\d*$/` **rejects commas** (`format.ts:83`) and returns `""`. `hasAmount` becomes false and the button falls back to "Enter an amount" — even though a value is visibly in the field.
- **Why it matters:** MAX/Half is the primary amount-entry affordance. It fails for any wallet holding ≥1,000 of the FROM token (≥~1,003 ADA for the ADA-MAX path after the reserve). The user sees a populated field with a dead, mislabeled button and no explanation.
- **Recommended fix:** Use a non-grouping formatter for MAX/Half, **or** strip commas in `toBaseUnits` (the more robust, defends-paste option).
- **Files:** `src/components/swap/SwapCard.tsx:188-192,291-292`; `src/lib/format.ts:48,80-94`
- **Approach:** Add `formatUnitsPlain()` (no grouping) and use it in `setFromAmount`; additionally make `toBaseUnits` tolerant by `input.replace(/,/g, "")` before validating. Cover with `format.test.ts` (Fix #9).

### 2. Headline rate line is decimal-unadjusted and contradicts the "To" amount
- **Severity:** High · **Area:** DeFi *(found in manual pass; not surfaced by the swarm)*
- **Current issue:** `quote.ts` computes `price = reserveOut / reserveIn` in **raw base units** (`quote.ts:40,52`) and the swap card renders it as `1 {fromTicker} ≈ {price} {toTicker}` (`SwapCard.tsx:666-671`). The base-unit ratio equals the human ratio **only when both tokens share decimals**. For an ADA(6)↔TEST(0) pool, the card shows e.g. "1 ADA ≈ 1.39 TEST" while the "To (estimated)" field shows ~124,000,000 TEST for 100 ADA — off by 10⁶ and self-contradictory. (The `amountOut`/minimum-received numbers are correct; only the displayed *rate* is wrong. `priceImpact` is dimensionless and unaffected.)
- **Why it matters:** The rate is a prominent, trust-critical number. Real-token decimals come from registry metadata, so any mismatched-decimal pair (extremely common) shows a wrong rate that disagrees with the amount right above it — corrosive to trust in a financial app.
- **Recommended fix:** Compute the displayed price in **display units**: `price = (reserveOut / 10^decOut) / (reserveIn / 10^decIn)`, i.e. multiply the base-unit ratio by `10^(decIn − decOut)`.
- **Files:** `src/lib/data/quote.ts:39-55`; `src/components/swap/SwapCard.tsx:664-671`; `src/lib/data/types.ts:58` (clarify the `price` contract is display-unit)
- **Approach:** In `quoteConstantProduct`, scale `midScaled` by the decimals delta using `tokenIn.decimals`/`tokenOut.decimals` (both available on the `Pool`'s `TokenInfo`). Keep the integer-string math; only the final display divisor changes. Add `quote.test.ts` asserting a 6↔0 decimal pair.

### 3. No visible keyboard-focus indicator anywhere in the app
- **Severity:** High · **Area:** Accessibility
- **Current issue:** There is **no `:focus-visible` rule in the entire codebase** (grep-confirmed), and `.k-input` plus the tip input / expiry select set `outline: none` (`globals.css:496`, `SwapCard.tsx:509,538`). Keyboard and switch users cannot see where focus is — including on the big amount field.
- **Why it matters:** WCAG 2.4.7 (Focus Visible) failure across every interactive element of a product that moves money. This alone fails most accessibility/legal bars.
- **Recommended fix:** Add one shared brand focus ring to the kit; never strip an outline without replacing it.
- **Files:** `src/app/globals.css` (`@layer components`); `SwapCard.tsx:509,538`
- **Approach:** Add a single block: `:where(.k-btn,.k-btn-ghost,.k-btn-danger,.k-btn-danger-soft,.k-pill,.k-link,button,a,select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` and, because pills use `outline:none`, prefer a `box-shadow` ring that follows the 999px radius. Wrap `.k-input` focus on its parent `.k-field` via `:focus-within`. One CSS block, no per-component edits.

### 4. Custom dropdown/menu popovers are not keyboard-operable
- **Severity:** High → **Medium** (verified) · **Area:** Accessibility
- **Current issue:** `TokenSelect`, `SlippageSettings`, and both `WalletBar` menus close only on outside **mousedown** — no Escape, no focus return to the trigger, no `role="menu"`/`listbox`, and `TokenSelect`/`SlippageSettings`/`ConnectMenu` triggers lack `aria-haspopup`/`aria-expanded`.
- **Why it matters:** Keyboard users can open these menus but can't escape them or perceive their state; screen readers announce them as plain buttons. Token selection and wallet connect are unavoidable steps.
- **Recommended fix:** Generalize the existing `useOutsideClose` into a hook that also closes on Escape and returns focus to the trigger; add the missing ARIA.
- **Files:** `src/components/swap/TokenSelect.tsx:18-83`; `src/components/swap/SlippageSettings.tsx:24-89`; `src/components/WalletBar.tsx:30-44,46-107,109-197`
- **Approach:** In the shared hook bind `keydown`→Escape (`onClose()` + `triggerRef.current?.focus()`). Add `aria-haspopup="listbox"` + `aria-expanded={open}` to the three triggers; `role="listbox"`/`role="option"` on the `TokenSelect` panel/items. Optional: roving focus / arrow-key nav.

### 5. Quote and token-load errors are silently swallowed; swap dead-ends with no retry
- **Severity:** High → **Medium** (verified) · **Area:** UX
- **Current issue:** `SwapCard` destructures `useTokens()`/`useQuote()` but ignores their `error` fields (`SwapCard.tsx:36,74`). If `/api/tokens` or `/api/quote` fails (provider 5xx/429, offline), the selectors stay empty or the rate sticks on "Fetching rate…" with no message and no way to retry. (`useQuote`/`useTokens` *do* expose `error` — it's just unused.)
- **Why it matters:** On a flaky network the core flow looks broken with zero feedback. Compare the Orders page, which has a proper error+Retry.
- **Recommended fix:** Surface an inline `k-note-danger` and a retry-capable button branch.
- **Files:** `src/components/swap/SwapCard.tsx:36,74,229-251,388`
- **Approach:** Read `tokensError`/`quoteError`; add a `quoteFailed`/`tokensFailed` branch to the `button` ladder and a small inline note (mirror Orders `error` block). Give `useQuote` a manual `reload()` like `usePools`.

### 6. Wrong-network gate can't tell preprod from preview
- **Severity:** High → **Medium** (verified) · **Area:** DeFi
- **Current issue:** CIP-30 `getNetworkId()` returns `0` for **all** testnets, and `config.ts:26` derives `networkId = 0` for both preprod and preview. So `networkReady` (`SwapCard.tsx:141`, `LiquidityPanel.tsx:69`, `orders:63`, `create:97`) passes a **preview** wallet straight through, and it builds a doomed tx against preprod deployment refs.
- **Why it matters:** A user on preview gets no "wrong network" warning and instead hits an opaque build/submit failure. The fail-closed design is otherwise excellent — this is its one blind spot.
- **Recommended fix:** Verify the *actual* chain, not just `0`/`1`.
- **Files:** `src/lib/config.ts:26`; the four gate sites above
- **Approach:** After connect, resolve a known deployment ref (`ORDER_REF`/`POOL_REF`) through the seam and gate `networkReady` on it resolving, or read the wallet's protocol magic where exposed and map preprod↔preview. Preserve the fail-closed shape (undefined still blocks).

### 7. Collateral check never re-queries → "set collateral & retry" advice dead-ends
- **Severity:** Medium · **Area:** UX / Wallet
- **Current issue:** `useWalletCollateral` queries once per `wallet`/`connected` change and never again (`useWalletCollateral.ts:26,58`). The LP/orders panels tell the user to "set a collateral UTXO and retry," but the button stays disabled until a full reconnect because nothing re-checks.
- **Why it matters:** The app surfaces the right guidance, then makes it impossible to act on without reconnecting — a frustrating dead-end on every script-spend flow (reclaim/deposit/withdraw/close).
- **Recommended fix:** Give the hook a `recheck()` trigger and/or re-poll on window focus while collateral is known-absent.
- **Files:** `src/hooks/useWalletCollateral.ts:26-58`; `LiquidityPanel.tsx:456-461`; `orders/page.tsx:288`
- **Approach:** Return `recheck` (bumps an internal nonce); wire a "Re-check" link into the collateral note. Optionally add `focus`/`visibilitychange` listeners that re-query while `!hasCollateral`. Keep writes in the deferred callback.

### 8. Silent MockProvider fallback can serve fake pools in production
- **Severity:** Critical → **Medium** (verified) · **Area:** Production
- **Current issue:** `getDataProvider()` defaults to the **mock** when `DATA_PROVIDER` is unset and `BLOCKFROST_PROJECT_ID` is missing (`index.ts:30`). A prod deploy that forgets the key serves *fabricated* tokens/pools/quotes; the deception only breaks at tx-build time (mock throws → 502).
- **Why it matters:** A misconfigured deploy looks fully functional with fake market data — the worst kind of silent failure for a financial app.
- **Recommended fix:** Refuse to fall back to mock in production unless explicitly opted in.
- **Files:** `src/lib/data/index.ts:30-47`
- **Approach:** In `createDataProvider`, if `process.env.NODE_ENV === "production"` and the resolved provider is `mock` without an explicit `DATA_PROVIDER=mock`, throw. Add a startup log of the active provider name.

### 9. No app-router error / not-found / loading boundaries (also the only unbranded screens)
- **Severity:** Medium · **Area:** Production / Brand
- **Current issue:** There is no `error.tsx`, `global-error.tsx`, `not-found.tsx`, or `loading.tsx` anywhere under `src/app/`. A render error or bad URL drops to Next.js's stock white screens — the one place Pip is absent.
- **Why it matters:** A thrown error on any page yields an unbranded crash with no recovery and no logging; a mistyped pool URL shows a generic 404. Both undercut the "polished, trustworthy" goal.
- **Recommended fix:** Add branded boundaries reusing the existing `Empty`/`k-note` patterns.
- **Files:** new `src/app/error.tsx` (client, `{error,reset}`, Pip `worried` + Retry), `src/app/not-found.tsx` (Pip `thinking` + link home), `src/app/global-error.tsx`, optional `src/app/loading.tsx` (`<PipLoading/>`)
- **Approach:** Model on `pools/page.tsx:353-372` `Empty`; route `error.tsx` messages through the existing `toUserMessage()` + `k-note-danger`. Log `error` from `error.tsx` for observability.

### 10. Three submit handlers lack the synchronous double-submit latch the others have
- **Severity:** Medium · **Area:** Code
- **Current issue:** `createPool` and `closePool` defend the double-click-before-rerender race with a `useRef(false)` latch (`create/page.tsx:93,139`; `LiquidityPanel.tsx:671,685`) — and their comments explain the exact double-spend hazard — but `handlePost` (`SwapCard.tsx:194`), `AddForm.submit`, and `RemoveForm.submit` (`LiquidityPanel.tsx:348,538`) gate only on closure-captured React state, which updates async.
- **Why it matters:** Two same-tick clicks can both pass the guard and build two txs from overlapping UTXOs; the second is node-rejected (`BadInputsUTxO`). Fail-safe (no funds lost in the common case) but an avoidable, inconsistent gap the authors clearly knew how to close.
- **Recommended fix:** Add the same `submitting` ref latch to all three handlers.
- **Files:** `src/components/swap/SwapCard.tsx:194-227`; `src/components/pools/LiquidityPanel.tsx:348-365,538-554`
- **Approach:** `const submitting = useRef(false); … if (submitting.current || !canPost) return; submitting.current = true; try { … } finally { submitting.current = false; }`

**Honorable mentions (just outside the top 10):** low-contrast `text-muted/60–/70` micro-copy at 10px fails WCAG AA (`SwapCard`, `LiquidityPanel`, `create`); create-pool doesn't proactively gate on collateral (`create/page.tsx`); slippage caps at 1.0% with no custom input despite the ≥5% impact warning (`SlippageSettings.tsx:5`); the `@meshsdk/react` pin is a **beta** (`1.9.0-beta.98`).

---

## Missing App States

Per screen — ✅ present & good · ⚠️ present but weak · ❌ missing.

| State | Swap | Orders | Pools list | Pool detail | Create pool | Add/Remove LP |
|---|---|---|---|---|---|---|
| Loading | ⚠️ "updating…"/no value skeleton | ✅ `PipLoading` | ✅ `PipLoading` | ✅ `PipLoading` | n/a | ✅ real `Skeleton` |
| Empty | ⚠️ no "no pools" guidance; ⚠️ blank `TokenSelect` popover possible | ✅ Pip empty | ✅ Pip empty + no-match | ✅ "can't find pool" | ✅ wallet-token hint | ✅ "no liquidity yet" |
| Error | ❌ quote/token errors swallowed (#5) | ✅ error + **Retry** | ⚠️ error, **no Retry** | ✅ error note | ⚠️ error, no retry | ✅ error note (no Pip) |
| Wallet disconnected | ✅ "Connect wallet" | ✅ Connect prompt | ✅ (read-only) | ✅ (read-only) | ✅ disabled + hint | ✅ "Connect wallet" |
| Wrong network | ✅ + sticky toast — ⚠️ but preprod/preview blind (#6) | ✅ gated | n/a | n/a | ✅ gated | ✅ gated |
| Insufficient balance | ✅ ADA path; ⚠️ non-ADA ADA-for-fees unchecked | n/a | n/a | n/a | n/a | ⚠️ no wallet-balance check on deposit amounts (LP) |
| Pending tx | ⚠️ 20–40s banner, no on-chain confirm tracking | ✅ pending→open via activity log | ✅ poll picks up new pool | ✅ poll | ⚠️ success banner only | ⚠️ success banner only |
| Failed tx | ⚠️ build/sign errors shown; **phase-2 fail after submit stays "success"** | ✅ reclaim error inline | n/a | n/a | ✅ error | ✅ error |
| Success | ✅ Pip + Confetti + explorer | ✅ reclaimed banner | n/a | n/a | ✅ Pip + Confetti + CTA | ✅ Pip + Confetti |
| Retry | ❌ swap | ✅ | ❌ list | ⚠️ self-polls | ❌ | ❌ |
| Disabled | ✅ labeled with exact reason (excellent) | ✅ labeled | ✅ | ✅ | ✅ labeled | ✅ labeled |
| Mobile | ✅ bottom `MobileNav`, safe-area | ✅ | ✅ responsive grid | ✅ | ✅ | ✅ — ⚠️ sub-44px tap targets |

**Most important gaps:** swap error/retry (#5); a post-submit phase-2 failure on swap/LP leaves a misleading "success" (the chain is the source of truth, but the UI should hedge); no retry affordance on swap/LP/create failures; pools-list error lacks the Retry that Orders has.

---

## UX Flow Review

**1. Landing** — *Polished.* Pip waving with sparkles, a one-line value prop, the swap card front-and-center, and an honest "How does this work?" disclosure explaining the batch-auction model and reclaimability. *Rough:* no first-run hint that the token list/quotes need a working provider; if `/api/tokens` fails the hero looks fine but the selectors are empty with no message (#5).

**2. Connect wallet** — *Polished.* Fully branded picker (no default Mesh modal), per-wallet icons, a friendly "no wallet found" message naming Eternl/Lace/Nami, silent auto-reconnect (armed-toast delay), connect/disconnect toasts. *Rough:* the picker/menu can't be closed with Escape or operated by keyboard (#4); the connect trigger lacks `aria-expanded`.

**3. Select token** — *Mostly polished.* Pill trigger + dropdown with ticker/name, registry logos with gradient-initials fallback, excludes the opposite side. *Rough:* keyboard/ARIA gaps (#4); a blank-list popover is possible if tokens failed to load.

**4. Enter amount** — *Mixed.* Strong: `inputMode="decimal"`, strict input masking, BigInt-exact half-up parsing, ADA reserve held back for fee+min-ADA+tip, clear over-balance vs over-spendable labels. *Rough:* **MAX/Half break ≥1,000 units (#1)**; the amount field has no visible focus ring (#3); non-ADA sells don't verify the wallet has ADA for fees+min-ADA+tip (fail-safe but late).

**5. Review swap** — *Mostly polished.* Collapsible rate line with price-impact, pool fee, solver tip, max slippage, a **bold Minimum received**, and graduated high-impact cautions (≥5% warn, ≥15% danger) with honest copy. *Rough:* **the rate number itself is wrong for mismatched-decimal pairs (#2)**; "best of N pools" is shown but there's no way to inspect/override the chosen pool; slippage can't exceed 1.0% even when the app warns about high impact.

**6. Submit** — *Polished.* Disabled-state button always names the exact blocker ("Leave ADA for tip + fees", "Checking network…", "Amount too small"). *Rough:* missing double-submit latch (#10); a click during a quote refetch can bind the floor to an in-flight price (Low).

**7. Wait** — *Adequate.* "Posting order…" → success in ~20–40s, with a localStorage activity log driving pending→open on the Orders page (genuinely thoughtful, indexer-lag-aware). *Rough:* no live on-chain confirmation tracking on the swap card itself; if the wallet disconnects mid-build the in-flight post isn't identity-checked.

**8. Success / failure** — *Polished on success* (Pip `love` + one-shot Confetti + explorer link + "what happens next" copy). *Rough:* a phase-2 failure *after* submit still reads as success; LP/create error banners drop the Pip that the swap error keeps (sterile "Transaction failed").

**9. Return to app** — *Polished.* Success copy points to Orders; Orders merges local + on-chain into pending/open/completed/reclaimed with tooltips and reclaim guidance; pools/pool pages self-poll so new state appears without manual refresh. *Rough:* reclaim/withdraw share the collateral dead-end (#7).

---

## UI Consistency Review

**Strong baseline.** `globals.css` is a model token-first system: raw values in `:root`, exposed to Tailwind v4 via `@theme inline`, with a documented `.k-*` kit that surfaces actually reuse — card padding (`p-5 sm:p-6`), note tints, chip colors, and `tabular-nums` on every number are uniform across pages. Dark mode is done at the token layer (`.dark` remaps surfaces + `--tint-base` so all `color-mix` tints adapt) with deliberate per-surface corrections. Reduced-motion is respected globally. Typography hierarchy is intentional (Baloo 2 display, Nunito body, mono only for hashes).

**Inconsistencies to clean up:**
- **Focus state missing entirely** (#3) — the one true hole in otherwise-thorough state coverage (hover/active/disabled are all handled).
- **Popover surface is a copy-pasted inline string** in 5 places (`TokenSelect:62`, `SlippageSettings:63`, `WalletBar:74,169`, `Toast:146`) with drifting shadow values and **no `.dark` softening** (unlike `.k-card`). Promote to a `.k-pop` kit class + `.dark .k-pop`.
- **Active-accent tint drift:** `bg-accent/12` (Nav, MobileNav, TabButton, pools controls) vs `bg-accent/15` (`SlippageSettings:78`) vs `hover:bg-accent/10` (SwapCard Half/Max). Pick 12% (ideally a `.k-toggle-active` class so it can't drift).
- **Off-kit form controls:** the Advanced tip input + expiry select (`SwapCard:502-545`) and the create-pool bps input bypass `.k-field`/`.k-input` with one-off classes → slightly different radius/border.
- **Sub-44px tap targets** on a touch-first layout: Half/Max (`text-[10px] px-2 py-0.5`), refresh ↻, slippage gear (`h-8 w-8`), toast dismiss (`h-6 w-6`).
- **"To" field has no value skeleton** while quoting — just a small "updating…" line; weaker than the LiquidityPanel skeleton.
- **Pools-list error lacks the Retry** the Orders error has — make error+retry uniform.

---

## Kawaii DeFi Brand Review

**The app fully commits to the kawaii DeFi identity — this is a real strength, not a veneer.** There is exactly one mascot (`Pip.tsx`), a single well-documented SVG with **9 context-aware moods**, reused everywhere: hero (wave+sparkles), card headers (happy), success (love + Confetti), error (worried), empty (sleepy/thinking), loading (`PipLoading` thinking), toasts (mood-per-variant), and the wallet picker/menu (wave/cool/thinking). The favicon (`icon.svg`) and social card (`opengraph-image.tsx`) are **real hand-built Pip renders** in the same palette — the Vercel favicon and generic OG were genuinely replaced. Copy holds a consistent whimsical-but-trustworthy voice ("a cozy, fair batch-auction house", "drop off an order", "grab it back anytime", "your keys, your coins") while staying serious on risk (graduated impact warnings; an honest open/completed status legend). `globals.css` even states the intent — "Premium cute, not childish — trust-critical numbers stay crisp" — and backs it with `tabular-nums` everywhere.

**Where the brand leaks (all minor / fixable):**
- **The unbranded screens are the only generic surfaces:** 404, runtime error, and route-loading fall back to Next.js defaults (#9) — the one place Pip should appear and doesn't.
- **Leftover scaffolding:** `public/` still ships the five default create-next-app SVGs (`vercel/next/window/globe/file`), unused — delete them.
- **Two sterile error banners:** LP (`LiquidityPanel.tsx:947`) and create-pool (`create/page.tsx:313`) show a bare "Transaction failed" with no Pip, while the swap error uses the warm Pip-`worried` + "Hmm, that didn't go through" treatment. Bring all three in line.
- **Voice typography nit:** `WalletWatcher.tsx:45,82` uses straight apostrophes ("Pip's") while the rest of the app uses curly ("Pip's"). Normalize.
- **OG wordmark** renders in Satori's default font, not Baloo — slightly off the app wordmark (Polish).

**Verdict:** cute *and* financially trustworthy. The two are balanced deliberately, not accidentally. *(Note: one swarm claim — "pools page is the only header without Pip" — was **invalidated** on verification; the create and pool-detail H1s also omit a beside-the-title Pip, so it's not unique. A consistency pass could add Pip to all three H1s, but it isn't the outlier the claim implied.)*

---

## Code Cleanup Plan

Prioritized, robustness-over-rewrite. The architecture is sound; this is tightening, not restructuring.

1. **Extract a shared write-gate.** The ladder `connected → wrongNetwork → networkReady → needsCollateral → busy → label` is hand-written in 5 places (SwapCard, AddForm, RemoveForm, CloseEmptyPool, OrderRowItem). Introduce `useWriteGate({ needsCollateral })` returning `{ canWrite, reason }` and a `submitting` ref helper (`useSubmitLatch`). This single change also fixes #10 everywhere at once and removes the most-duplicated logic in the app.
2. **Fix the two display/parse bugs at the source** (#1, #2) in `format.ts` and `quote.ts` — the lowest-surface-area, highest-trust fixes; lock them with tests.
3. **Promote two CSS one-offs to the kit:** `.k-pop` (popover surface + dark variant) and a focus-visible block (#3) — removes 5 inline duplications and closes the a11y hole in one place.
4. **Centralize decimals-aware display.** Several call sites format money; the `price`-vs-decimals bug shows the risk. Consider a `formatRate(reserveIn, reserveOut, tokenIn, tokenOut)` helper so no caller re-derives a ratio by hand.
5. **Harden the data seam boundary** (#8): production guard in `createDataProvider` + a one-line active-provider log via the existing `console.error` channel in `lib/api.ts`.
6. **Surface the errors the hooks already expose** (#5): `useQuote`/`useTokens` return `error` — wire them through and add a `reload()` to `useQuote` to match `usePools`.
7. **Add the missing collateral `recheck`** (#7) and consider folding collateral gating into the shared write-gate from step 1.
8. **Dead-asset sweep:** delete the five `public/*.svg`; confirm no `next.config.ts` warnings; pin or upgrade the **beta** `@meshsdk/react` to a stable release before launch and document why if it must stay beta.

---

## Test Plan

Current coverage is solid on the pure chain layer (`address`, `closePool`, `createPool`, `datums`, `lp`, `order`) and two client utils (`errors`, `orderRows`) — but the **highest-trust pure functions and all React/hook/tx code have zero tests**, and the runner has a footgun.

**P-1 · Unit (highest value first):**
- `format.test.ts` — **the most important missing test.** `toBaseUnits` round-trips across decimals 0/6/8; half-up boundary (`1.9`@0dec→`2`, `0.0000005`@6dec rounds up); trailing/empty/`"."`/over-precise inputs; comma rejection (regression for #1); `formatUnits`/`formatBaseUnitString` for values > `Number.MAX_SAFE_INTEGER`.
- `quote.test.ts` — known reserves+fee → expected `amountOut`; zero/empty-reserve guards; fee boundary; **decimal-adjusted `price` for a 6↔0 pair (regression for #2)**; `priceImpact` monotonicity.
- `tx` pure helpers — extract `collateralRefs`/`fundingUtxos` exclusion (`tx.ts:240-245,300-305`) and the min-ADA/tip arithmetic into exported pure fns and assert: collateral never appears in funding; seed excluded in create; reclaim builds `<hash>#0` correctly.
- `blockfrost.ts` mapping helpers — feed raw payload fixtures into `reserveOf`/`feeToBps`/`toPosition`/`isRetriable` and assert `Pool`/`WalletPosition` shapes and the 429/5xx retry classification.

**P-2 · Component / integration (jsdom + Testing Library):**
- `SwapCard`: disabled-label ladder per state; MAX/Half populate a *usable* value (#1); over-balance vs over-spendable; wrong-network/`networkReady` gating; success→amount-cleared.
- `LiquidityPanel`: add/remove preview math, max-burnable cap at `circ − MIN_LIQ`, creator-only close confirm flow.
- `WalletWatcher`: connect/disconnect/wrong-network toast transitions incl. the armed-delay.

**P-3 · E2E (Playwright, against the MockProvider):** full happy path (connect → select → enter → review → post → Orders shows pending); reclaim; create→seed hand-off; **keyboard-only pass** asserting visible focus + Escape-closes-menus (locks #3/#4); wrong-network and error/empty renders.

**P-3 fix — runner reliability:** `npm test` relies on Node ≥22.6 `--experimental-strip-types`; on Node 20 it errors **but the npm script still exits 0** (observed directly in this environment — a false green if the CI/dev Node ever drifts below 22.6). `engines.node:">=22.6.0"` is declared but unenforced. *(A verifier marked this "Invalid" on the grounds that the supported Node runs fine — true — but the silent exit-0 on an unsupported Node is a real CI-hygiene footgun.)* Add `engine-strict=true` (`.npmrc`) and/or a preflight Node-version check in the test script, and pin the CI Node to 22.

---

## Final Polish Checklist

Small, concrete, finishable in a focused pass:

- [ ] MAX/Half produce a usable value for ≥1,000-unit balances (#1)
- [ ] Rate line is decimal-adjusted and agrees with the "To" amount (#2)
- [ ] One shared `:focus-visible` ring across the `.k-*` kit; remove bare `outline:none` without a replacement (#3)
- [ ] Menus close on Escape + return focus; add `aria-haspopup`/`aria-expanded`/`role` (#4)
- [ ] Swap surfaces quote/token-load errors with a retry (#5)
- [ ] Distinguish preprod from preview in the network gate (#6)
- [ ] Collateral note has a working in-app re-check (#7)
- [ ] Production guard against the silent mock fallback + log the active provider (#8)
- [ ] Add branded `error.tsx` / `not-found.tsx` / `global-error.tsx` (+ optional `loading.tsx`) (#9)
- [ ] Add `submitting` ref latch to swap/add/remove handlers (#10)
- [ ] Bump `text-muted/60–/70` micro-copy to solid `text-muted`; raise 10px → 11–12px where it carries meaning
- [ ] Custom slippage input (clamped, caution > 5%); gate create-pool on collateral
- [ ] Promote popover surface to `.k-pop` (+ `.dark .k-pop`); unify active-accent tint to 12%
- [ ] Grow Half/Max, slippage gear, toast dismiss, refresh ↻ to ≥40–44px touch boxes on mobile
- [ ] Give the "To" field a value skeleton while quoting; add Retry to the pools-list error
- [ ] LP + create error banners get the Pip-`worried` treatment; normalize straight→curly apostrophes
- [ ] Add a skip-to-content link + `id="main"`; `aria-pressed`/tablist on tab + slippage-preset groups; `aria-live` on the estimated-output/minimum-received numbers
- [ ] Delete the five default `public/*.svg`; resolve the beta `@meshsdk/react` pin; `engine-strict` + CI Node 22
- [ ] Add `format.test.ts` + `quote.test.ts` (regressions for #1/#2) before merging the fixes

---

*Methodology note: findings were produced by a full manual read of every file in `app/src` plus a 9-dimension agent swarm, with each finding independently verified against the source. Verifiers down-graded several initial severities (e.g. the mock fallback Critical→Medium, the unbranded-screens High→Low) and invalidated two over-stated claims; those adjustments are reflected above. Severities here are the post-verification values.*
