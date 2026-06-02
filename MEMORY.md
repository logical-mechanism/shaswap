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

**Off-chain reference solver WORKS LIVE end-to-end** on branch
`batcher/reference-solver` (66 tests, clippy -D + fmt clean). Crates: **`solver-core`**
(clearing mirror + v1 floor-only solver + sim), **`txbuild`** (Plutus Data encoder,
addresses, values, plan), **`shaswap-txbuilder`** (forked pallas-txbuilder w/ withdraw-0),
**`chain`** (Kupo+Ogmios `ChainBackend` + `assemble` body stitch + Config/decode/fees),
**`orchestrator`** (bin `shaswap-batcher`: discover→solve→assemble→evaluate→submit).
**Proven on preprod:** a one-sided settlement (`05d99063…`) AND a perfect two-sided
**netting** (`4e12d57f…`, pool untouched) built+signed+submitted entirely by the Rust
batcher. Services: `happy_path/run-{ogmios,kupo}.sh`. **Next (batcher polish, optional):**
a continuous loop (it's currently one-shot per invocation), mempool-aware order posting,
multi-funding/auto-split when <2 pure-ADA UTXOs. **Still owed on-chain:** an **emulator
pass** with a real `Data` ScriptContext (confirms the ~40-order ceiling + decoding cost),
and folding the clearing-price/ADA-triple-role specs into exact rounding rules. Later:
**true-equilibrium** cost spike (§5.2.7). The **app** now reads preprod live, posts/reclaims
orders, adds/removes liquidity (LP deposit/withdraw), and **creates pools** behind the data
seam (see the 2026-06-01 and 2026-06-02 log entries). **Done on-chain:**
trust anchor, order/pool/pool_mint validators, LP path, pool close, bidirectional netting,
deadlines, partial fills.

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
- Solver tip mechanics; order rollover; `λ`/fee defaults; sharding defaults; ~~data
  provider choice~~ (app uses **Blockfrost** behind the seam, server-side key).
- ~~**⚠️ PRE-RELEASE: owner payout is an ENTERPRISE address → breaks some wallets.**~~
  **RESOLVED 2026-06-01 (Blueprint Rev 21, base-address payout).** `OrderDatum` gained
  `owner_stake: Option<Credential>` (field index 1); the settlement owner-payout pin now
  builds `{ payment = owner, stake = owner_stake }` — `Some` → a **base** address (Lace
  shows + spends it), `None` → enterprise. The stake is read FROM the datum so the solver
  can't redirect it (M-01 preserved). Mirrored in the batcher + app; the app's `buildOrder`
  attaches the wallet's reward-address stake cred. **Verified live on the redeployed
  preprod** (see the 2026-06-01 base-address log entry): a settlement paid the owner at a
  base address that the owner key then spent. (Lace *display* is the maintainer's final
  browser check.)

## Log

- **2026-06-02** — **App create-pool — mint a new pool (branch `app/create-pool`).**
  Added the last missing app write path: `/pools` could read + LP, but couldn't **create** a
  pool. Pool creation is **permissionless** (a hyperstructure requirement — anyone may create
  one); it's a standalone user-driven **mint** tx (no solver, no settlement anchor) — and the
  app's **first mint** (the LP paths only spent). The new technique vs. LP: each pool has its
  **own one-shot policy** `pool_mint(seed)`, so the app instantiates it **client-side** —
  `applyParamsToScript(POOL_MINT_COMPILED_CODE, [encodeOutputReference(seed)], "Mesh")` then
  `resolveScriptHash(applied, "V3")` = the per-pool NFT/LP policy id (both pure → data seam
  untouched). Mirrors `mint.create`: mint **exactly** `{NFT:1, LP:total_lp}` under that policy
  and **nothing else**, both into **one** output at the shared `POOL_ADDR` (all pools share it —
  the pool *validator* is parameterised by `S`, only the NFT/policy differs) with an inline
  `PoolDatum` (`nft.policy==policyId`, `nft.name==4e4654`, `asset_a!=asset_b`, neither under the
  new policy, `0<=fee_num<fee_den`, **VK** creator). **Creates an EMPTY pool** (no reserves ⇒
  `circ==0`); the creator seeds it via the **existing deposit flow** (`/pools/[id]` first-deposit
  branch) in a **separate** tx — avoids the first-depositor donation quirk and the can't-spend-
  just-created-pool constraint. **Layers (app only — no contract/batcher change):** `datums.ts`
  (`mintCreateRedeemer`/`mintCloseRedeemer`), `deployment.ts` (`POOL_MINT_COMPILED_CODE`, the
  unapplied `pool_mint` compiledCode; unapplied hash `9ff1ef18…`), pure builder
  `chain/createPool.ts` (`buildCreatePool` — throws on any malformed intent), `tx.ts`
  `createPool` (seed = a pure-ADA wallet UTXO consumed via `.txIn`; two same-policy mints +
  inline script + Create redeemer; one pool txOut; collateral + `setCostModels` + evaluator), and
  a dedicated **`/pools/create`** page (token A/B from **wallet assets + ADA**, fee in bps →
  reduced `num/den`, ADA normalised to `asset_b`) + a **Create pool** button on `/pools`; success
  → "add initial liquidity" CTA to `/pools/[id]`. **Cross-checked the policy id byte-for-byte**
  against the contract toolchain: for seed `(77×32)#3` (mint_test.ak's seed), MeshJS's
  `applyParamsToScript`+`resolveScriptHash` == `aiken blueprint apply`+`cardano-cli policyid` =
  `68cd7477…c408d` — pinned in `createPool.test.ts` (also determinism + the `create_ok` datum/
  value + malformed-intent rejections). **47 app tests, build + lint green** (Node 22); `aiken
  check` untouched/green. **Adversarial multi-lens review** (5 lenses + per-finding verification)
  → 4 fixes: disable Create after success (a second click would mint a **duplicate** pool, new
  seed, wasted funds); **`usePools` now polls 15s** (was fetch-once) so the create→"add initial
  liquidity" hand-off self-heals during the indexing gap (was a terminal "Pool not found");
  `assetFromUnit` rejects **odd-length hex** (MeshJS would silently encode it as text) and
  `buildCreatePool` compares **normalized AssetIds** not raw units ("lovelace"≡"", case-variants)
  — both uphold the strict-rejection invariant. A second **xhigh 9-angle review** (67 agents) found
  no fund/protocol bug; 4 more fixes: `usePools` now **suppresses transient poll errors once a list
  loaded** (the new 15s poll was stacking a "Failed to load" banner over a still-valid list — a
  regression vs the old fetch-once), an **in-flight guard** on the create submit (a fast double-click
  no longer double-spends the seed), a friendlier `/pools/[id]` not-found message during the indexing
  gap, and dropped the unused `reload` export. **Base-branch note:** the LP work (`app/lp-add-remove`) wasn't on `main`
  yet, so per the maintainer it was **fast-forwarded into `main` first**, then `app/create-pool`
  branched off the updated `main`. **Owed (maintainer):** the live in-browser preprod run —
  create a pool, confirm `{NFT:1,LP:total_lp}` under the freshly-applied policy in one
  `POOL_ADDR` UTXO with the computed `policyId`, see it in `/pools`, then add initial liquidity
  (services `happy_path/run-{ogmios,kupo}.sh`; `happy_path/04-create-pool.sh` is the cli ground
  truth — note it *seeds* reserves, the app deliberately doesn't). **Not committed-to-PR** —
  branch left for the maintainer.

- **2026-06-02** — **App LP add/remove — deposit + withdraw write path (branch
  `app/lp-add-remove` off `main`).** Closed the last app UX gap: `/pools` was read-only, so
  users couldn't provide/remove liquidity. Added the client-side LP **deposit** + **withdraw**
  flows mirroring order post/reclaim — a standalone user-driven tx (no solver, no settlement
  anchor): spend the pool UTXO with `LpAction` (Constr 1 []) via the pool **reference script**
  (`POOL_REF` = `78130a6c…#1`, size **2236**), recreate the pool at the same address with the
  **same inline datum** (CBOR passthrough → `out.datum == in.datum`), 1 NFT, reserves ±Δ and
  the `held` LP moved by the share delta; `tx.mint == 0`; **no owner signature**
  (`lp_action` checks per-share backing, not a sig). **Share math** is a pure, unit-tested
  mirror of `spend.lp_action` in `app/src/lib/chain/lp.ts` — floor everything: subsequent
  deposit `lp=min(⌊Δa·circ/res_a⌋,⌊Δb·circ/res_b⌋)`, withdraw `recv=⌊burn·res/circ⌋`, first
  deposit `circ_out=⌊√(res_a·res_b)⌋` with `min_liq` locked at `Script(nft.policy)`;
  `lp.test.ts` replicates every `lp_test.ak` fixture to the unit (**40 app tests, build +
  lint green**, Node 22). **Layers (app only — no contract/batcher change):** `datums.ts`
  (`lpActionRedeemer`), `deployment.ts` (`POOL_REF`/`POOL_SCRIPT_SIZE`/`TOTAL_LP`/`MIN_LIQ`/
  `lpUnitForPool`), `address.ts` (`deriveEnterpriseScriptAddress` for the lock), the `lp.ts`
  builders, data seam `resolvePoolUtxo` + `/api/tx/pool-utxo` route + client shim, `tx.ts`
  `depositLiquidity`/`withdrawLiquidity`, and a **dedicated `/pools/[id]` manage page** +
  `LiquidityPanel` (Add/Remove tabs, auto-paired deposit, LP/asset previews, slippage min-out
  guard, "your position" from the wallet's LP balance). **Live LP unit** for the current pool:
  `3d36f7963dcca05ba53e32babdf3c2572d467c7388dbb1cf4b28645f` + `4c50` (NFT `…4e4654`).
  **cardano-cli ground truth:** `happy_path/07-lp-deposit.sh` (doubles as the **bootstrap** —
  first-deposit `√` + `min_liq` lock, takes circ 0→>0) and `08-lp-withdraw.sh`, each printing
  the computed reserves/circ to cross-check the app math. **Owed (maintainer):** the live
  preprod run — bootstrap to `circ>0` (the redeployed pool is seeded res_a=res_b=1e9 with
  `circ==0`), then in-browser deposit/withdraw + a deliberate overmint/over-withdraw rejection
  (services `happy_path/run-{ogmios,kupo}.sh`). **Not committed-to-PR** — branch left for the
  maintainer to test first.
- **2026-06-01** — **🎉 BASE-ADDRESS owner payout — full redeploy + live proof (branch
  `contracts/base-address-payout` off `main`, app branch merged in).** Resolved the
  pre-release enterprise-payout limitation across all four layers + Blueprint Rev 21.
  **Design:** `OrderDatum` gains `owner_stake: Option<Credential>` (field index 1, right
  after `owner`; OrderDatum now **9 fields**, still distinct from PoolDatum's 6). The
  settlement owner-payout pin (`utils.is_payout_output`) now builds `{ payment = owner,
  stake = owner_stake }` instead of `stake = None`: `Some(c)` → a **base** address (so
  Lace-style delegating wallets display + spend the settled funds), `None` → the prior
  enterprise address. **M-01 preserved:** the stake half is read FROM the order datum, so
  the solver can neither choose nor redirect it (address stays deterministic + fully
  pinned; `reference_script == None` for L-01; owner payment cred stays VK for reclaim). A
  partial-fill **remainder** must carry the same `owner_stake` (continuity pin), so the
  rollover can't swap the delegation. **Layers:** (1) `contracts/` — `types.ak`/`utils.ak`/
  `clearing.ak`; +7 Aiken negatives/positives (**103 green**: base key/script-stake OK,
  wrong-stake/dropped-stake/script-stake-fuzz rejected, remainder-stake continuity).
  (2) `batcher/` — `solver-core` types/output/clearing + `txbuild::plutus` encode +
  `chain::decode` decode (encoder↔decoder round-trip + golden CBOR green; clippy -D + fmt
  clean). (3) `app/` — `datums.ts` codec (9-field, new golden CBOR byte-identical to the
  batcher), `order.ts`/`tx.ts` (`buildOrder` + `postOrder` derive the wallet's stake cred
  from the change address; null → enterprise), `deployment.ts`/`address.test.ts` synced to
  the new identities; **25 tests, build + lint green** (Node 22). (4) **Redeployed
  preprod** end-to-end via `happy_path/` (cardano-cli): regenerated param-applied scripts,
  re-registered `S` (publish handler authorized it), redeployed 3 ref scripts, re-minted
  TEST + recreated/seeded a pool, posted an order with `owner_stake` = a new solver stake
  key, **settled** it — the owner payout landed at the **base** address
  `addr_test1qq6vymyr2…` (`addr_test1q…` = payment+stake) and the **owner key then spent
  it** (proving spendability). **New live identities** (also in `happy_path/deployment.json`
  + app `deployment.ts`): S `a57de7a9191ab5544173287119f7203724c2d7a7b0457d367545211e`,
  order `801c7a4c4268b986d0dfd90010ee5d5708c18b19be485b53e88d22f2`, pool
  `4427ef8453f1acb4fac3844fbc7c34852fe188e4ab99f3fda07b533b`, pool_mint
  `3d36f7963dcca05ba53e32babdf3c2572d467c7388dbb1cf4b28645f`, TEST policy `8160c878…`
  (unchanged, deterministic sig-policy), ref scripts tx
  `78130a6c6f88173ac3b6c75babb10de03f68b239213e95f4a83d5959fec8fc7e` (settlement#0,
  pool#1, order#2), settle tx `751f7a6e6cdc670cb41f6ff479b84b07d7eec03c64d41270a0dfa5951d3c7545`.
  Order ref-script byte size 536→**537**. **Owed (maintainer):** the final in-browser Lace
  check (post from the app with a funded Lace wallet, settle, confirm Lace *displays* the
  base-address payout) — can't be done headlessly. **Not committed-to-PR** — branch left
  for the maintainer to test then open the PR.
- **2026-06-01** — **App goes live on preprod: real reads + non-custodial order
  POST & RECLAIM (branch `app/onchain-read-post-reclaim` off `main`).** The web app now
  *does* things on-chain (settlement stays the solver's job). **Provider (user choice):
  Blockfrost (hosted)** behind the existing seam — `BLOCKFROST_PROJECT_ID` is
  **server-only** (read in `getDataProvider()`/route handlers, never shipped to the
  browser; safe as a plain DigitalOcean env var); `.env.example` committed, `.env.local`
  gitignored. Falls back to `MockProvider` with no key. **(1) Real reads:**
  `app/src/lib/data/blockfrost.ts` (`implements DataProvider`) discovers pools/orders at
  the `S`-tagged pool/order addresses and decodes inline datums; pools identified
  **generically** (UTXO holds the NFT its own `PoolDatum` declares — mirrors batcher
  `find_pools`, so no per-pool config; both live pools surface). Reserves carve
  `pool_min_ada` from an ADA side (`reserve_of`). Verified live: `/api/pools` returns the
  two real TEST/ADA pools, `/api/quote` computes off real reserves, `/api/tokens`,
  `/api/orders` all serve preprod data; key stayed server-side. **(2) Plutus codec**
  `app/src/lib/chain/datums.ts` mirrors `plutus.json` + the batcher's `txbuild::plutus`
  — MeshJS `mConStr`/`serializeData` produce **byte-identical** CBOR (`d87980`,
  `d8799f4040ff`, full order datum golden = the Rust `round_trips_through_decode`
  fixture). **`buildOrder` rejects malformed intents (throws — never silently posts).**
  **(3) Post order:** client-side `MeshTxBuilder` (`lib/client/tx.ts` `postOrder`) builds a
  plain payment to `ORDER_ADDR` with the inline `OrderDatum` + value (min-ADA + tip [+
  sold ADA for the ADA triple-role]); wallet signs+submits (non-custodial). Wired into
  `SwapCard` (Connect → amount → Post order; floor = quote × (1−slippage); advanced
  tip/partial). **(4) Reclaim:** `reclaimOrder` spends the order UTXO with `Reclaim`
  (`Constr 1 []`) via the on-chain **order reference script** (`ORDER_REF`, size 536 B),
  owner-signed, collateral from wallet, ex-units via `/api/tx/evaluate`; `/orders` page
  shows a Reclaim button per live order. **Seam additions** (all behind `/api/*`, key
  server-side): `protocolParameters` (`/api/protocol-params`), `evaluateTx`
  (`/api/tx/evaluate`), `resolveUtxo` (`/api/tx/utxo`); client uses thin shims so no
  provider SDK runs in the browser. **Order/pool addresses** derived in
  `lib/chain/address.ts` via `Cardano.BaseAddress.fromCredentials` with **script** stake
  cred (MeshJS `scriptHashToBech32` makes a *key* stake cred → wrong type); **pinned** to
  the committed constants by `address.test.ts`. **Tooling:** tests run on Node's built-in
  runner with `--experimental-strip-types` (zero new deps; `*.test.ts` excluded from the
  Next build + eslint, use explicit `.ts` specifiers; `allowImportingTsExtensions` on so
  source `./x.ts` imports satisfy both Node and Turbopack). **13 tests, `npm run build` +
  `lint` green** (nvm node 22 — snap node swallows stdout). De-risked the build path
  offline: post-order tx builds with REAL preprod params (no fetcher needed, 389-byte
  CBOR). **Owed (user, in browser):** the final live post+reclaim with a CIP-30 wallet
  funded on preprod. **Not merged** — PR left for the maintainer; `contracts/`/`batcher/`
  untouched.
- **2026-06-01** — **App skeleton stood up (`app/`, branch `app/skeleton`).** Scaffolded
  the web dApp shell — structure + clean swap-card UI + wallet connect + the data-access
  seam — wired end-to-end against **mock data**. **No** settlement/clearing/order-building
  or real provider access yet (deferred to later branches). **Stack:** Next.js 16 (App
  Router) + TypeScript strict + Tailwind v4; MeshJS `@meshsdk/react` (`MeshProvider`,
  `useWallet`/`useAddress`/`useLovelace`/`useNetwork`, `CardanoWallet`) + `@meshsdk/core`.
  Bundler is **Turbopack** (Next 16 default — resolves MeshJS's WASM serialization libs
  natively, so no webpack config; an earlier webpack `asyncWebAssembly` config conflicted
  with the default Turbopack and was removed). **MeshJS version pin (decided):**
  `@meshsdk/react` has **no stable** on npm (only betas; `latest`=`2.0.0-beta.2`, both Feb
  2026), so it's pinned **exactly** to `1.9.0-beta.98` — the build matching the stable
  `@meshsdk/core@1.9.0` train (wallet/transaction/common all 1.9; `@meshsdk/wallet` resolves
  to stable **1.9.0**), keeping ONE wallet major in the tree (the `2.0.0-beta.2` react pulled
  in `@meshsdk/wallet@2.0`). NB the `meshjs` unscoped pkg on jsdelivr (`1.9.0-beta.102`) is a
  separate app-*bootstrapper*, not our dep. Node pinned via `app/.nvmrc` (`22`) + `engines`
  `>=20.19.0` — using nvm node also sidesteps snap node's swallowed stdout. tsconfig `target`
  bumped ES2017→**ES2020** for BigInt literals. **The data-access seam (CLAUDE.md HARD RULE):** one typed `DataProvider`
  interface (`listTokens/listPools/getPool/priceQuote/walletPositions`) + domain types
  (`TokenInfo`/`Pool`/`Quote`/`OrderIntent`/`WalletPosition`) in `app/src/lib/data/`;
  a `MockProvider` (static data + toy constant-product quote — NOT the protocol clearing);
  **the server is the data layer** — provider calls live in Next route handlers
  (`app/src/app/api/{tokens,pools,quote,orders}/route.ts`), the client only ever fetches
  our own `/api/*` (via `src/lib/client/api.ts` + `src/hooks/use{Tokens,Pools,Quote,Orders}`).
  Swapping in a real provider / our own Dolos node = **one-file change**: implement
  `DataProvider` and return it from `getDataProvider()` in `src/lib/data/index.ts` (commented
  `switch` stub there). Network is a **single config value** (`src/lib/config.ts`, default
  **preprod**; `NEXT_PUBLIC_NETWORK` override; CIP-30 networkId derived; header flags
  network mismatch). **UI:** sticky nav (wordmark + Swap/Pools/Orders + `CardanoWallet`
  + address/balance/network pill), centered swap card (from/to selectors, direction toggle,
  mock rate/price-impact line, visual-only slippage popover, state-aware primary button
  *Connect wallet → Enter an amount → Swap (coming soon)*, **always disabled — builds/submits
  nothing**), `/pools` + `/orders` stubs reading mock through the seam, dark gradient theme,
  mobile-responsive. **Verified:** `npm run build` + `npm run lint` green; dev renders `/`,
  `/pools`, `/orders` (200) and `/api/*` return mock JSON (quote 10 ADA→~13.7 TEST, impact
  1.44%); CardanoWallet button renders. (Full browser wallet-connect needs a real extension —
  not headless-testable here.) Docs: `app/README.md` (stack/run/seam/scope). MeshJS Agent
  Skills already vendored in `.claude/skills/` (prior `chore/mesh-skills` merge).
  **Code-review pass applied** (high-effort, 7 angles): fixed `Number()` precision loss
  in `format.ts` (now BigInt-exact, matters for >2^53-lovelace balances/reserves), the
  `/orders` wrong-empty "No orders yet." flash (`useOrders` now derives `loading` — no
  deferred-timer), added provider-error guards + input validation on the `/api/*` routes
  (shared `lib/api.ts` `providerJson`, 502 on throw / 400 on bad `amount`), made
  `toBaseUnits` round (not truncate) and reject bare `.`, and added the missing abort guard
  in `useTokens`. Left as noted/deferred: mock price `Number()` precision (mock-only),
  single-token-list `toToken` guard, and the dedup cleanups (shared `Empty`/`useClickOutside`/
  abortable-fetch hook). PR opened off `app/skeleton`; NOT merged — left for the maintainer.
- **2026-06-01** — **Batcher production-readiness pass (v1 daemon hardening).** Made the
  reference solver safe to run unattended under systemd. (1) **Graceful shutdown:** added
  `signal-hook`; SIGTERM/SIGINT flip an `AtomicBool` checked **only between passes** (a
  signal never interrupts a pass mid-build/submit → no ambiguous chain state), then it logs
  + exits 0. `sleep_responsive` wakes in ≤250ms steps so shutdown is prompt at any cadence.
  (2) **Fast by default:** poll cadence is now millisecond (`SHASWAP_INTERVAL_MS`, `_SECS`
  kept ×1000 for back-compat). It's safe to poll briskly because we key off **Kupo's**
  checkpoint (never read ahead of what Kupo indexed); the latency floor is Kupo's index lag,
  not the cadence — so an Ogmios chain-sync push buys ~nothing over fast polling and was
  deliberately NOT added. (3) **Dust / token-poisoning defense:** funding selection now
  requires `value.is_ada_only()` — a gifted token-bearing UTXO at the public solver address
  can't be chosen as funding (its foreign tokens would ride into the change output and
  bloat its min-ADA/size until unbuildable). A datum on an ada-only vkey UTXO is inert
  (doesn't propagate to change), so those still fund fine; settlement change is always
  ada-only, so the solver self-funds indefinitely and gifted tokens sit unused. (4) **P&L
  readout:** each pass logs `balance_ada` + `delta_ada` (drift since first pass) — a
  confirmed settlement moves the solver's ADA only by tips−fee and collateral is constant,
  so the wallet-balance trend IS realized profit (user's suggestion: "checking the wallet
  balance would work"). (5) **`isValid == true` invariant locked:** the fork hardcodes
  `success: true` with no API to set it false (documented; `is_valid_is_always_true` decode
  test) — so the batcher can never emit a collateral-burning is-false tx, and combined with
  the EvaluateTx gate the node always accepts our tx phase-2 → **collateral is never
  consumed.** **Proven live:** daemon at 500ms logged the balance/P&L and shut down cleanly
  on SIGTERM between passes (exit 0). **85 tests** (+4: dust-funding rejection, isValid decode,
  pending TTL/exclusion already there), clippy -D + fmt clean. **Scope decisions (user):**
  v1 multi-asset = arbitrary 2-asset pairs (already done, Rev 10); >2-asset *multilateral*
  clearing stays deferred (not needed). Surplus-max stays deferred. Single-batcher + cap 20
  for now; competitive multi-solver tests deferred. Collateral assumed never taken (holds by
  the isValid+gate invariant above).
- **2026-06-01** — **Configurable drain strategy (round-robin | profit-greedy).** The
  cross-pool/shard ordering a pass attempts pools in is now a config knob: deployment-JSON
  `strategy` (default `"round-robin"`; env override `SHASWAP_STRATEGY`), parsed into an
  orchestrator `Strategy` enum (extensible — add a variant + a `settlement_plan` match arm
  for fancier policies later). `round-robin` = sort-by-NFT + cursor rotation (fair, no pool
  starved); `profit-greedy` = highest Σ-posted-tips first (deterministic NFT tie-break).
  **Ordering only** — every settleable pool is still attempted; *which* orders settle is the
  per-order floor + the fee-cover gate, identical for every strategy (so strategy changes
  *who wins what / how fast* under competing solvers, never batchability). Recorded the
  multi-solver game-theory reasoning: all-greedy herds on the richest pool (latency-decided,
  centralizing) and isn't a stable equilibrium — solvers are incentivized to disperse, so a
  mixed population self-balances (greedy clears value fast, round-robin mops up the rest);
  this mirrors SAMM's dispersion logic applied to solvers. **Proven live (dry-run):** posted
  a low-tip order to pool `1c3be7b9` + a high-tip order to pool `a2c6916e`; round-robin solved
  `1c3be7b9` first (NFT order), profit-greedy solved `a2c6916e` first (tip 5M > 2M), reversing
  it — both attempting both pools. **83 tests** (+2: profit-greedy ordering + tie-break, strategy
  parse aliases/fallback), clippy -D + fmt clean.
- **2026-06-01** — **Batcher hardening — code-review fixes (tx chaining made safe/reliable).**
  Acted on a high-effort multi-agent review of the chaining diff (3 candidates refuted as
  safe: Ogmios rejecting already-spent `additionalUtxo` — each evaluate is independent, proven
  live; cap-after-price under-solving — feasibility is judged on the capped subset; fee-cover
  break stranding high-tip orders — the check is on the tip *sum* and solve maximizes count).
  Fixed the rest:
  - **In-flight tracker with TTL + funding (was order-only, never-expiring).** `LoopState`
    now holds `pending: HashMap<Key, slot>` for every input spent by a submitted-but-
    unconfirmed tx — settled order refs AND the wallet **funding** UTXO. Orders in `pending`
    are excluded from settlement and pending wallet UTXOs from `select_inputs`, so a still-
    mempool chain can't be double-spent across passes (Kupo only marks inputs spent on block
    confirmation — the old code re-selected funding and could double-spend). Entries expire
    after `PENDING_GRACE_SLOTS` (180), so a failed/never-confirmed tx's inputs are retried
    instead of stranded forever (the old `in_flight` had no expiry → a non-confirming tx
    froze its orders permanently). Collateral is deliberately NOT tracked (reused).
  - **Submit failure aborts the whole pass.** `settle_pool` returns `PassError::{SkipPool,
    AbortPass}`: a solve/assemble failure (nothing submitted) skips the pool and continues;
    a **submit** failure aborts the pass (the rolling funding is then ambiguous — the tx may
    be in the mempool — so no later link may reuse it). Next pass re-discovers real state.
  - **`chain.resolved` pruned to O(1).** A link's only off-chain inputs are the immediately-
    prior tx's change (funding) + pool-continuation output, so `resolved` now holds just those
    two (was an unbounded accumulation re-serialized into every gate call → O(M²) payload).
  - **Output layout single-sourced.** `build_signed` now returns the next `PoolInput` (built
    from the same data as the `pool_out` `ResolvedUtxo`, no caller hand-merge), and
    `build_staging` asserts the built tx's output count matches `change_output_index` — so a
    future output reorder fails loudly instead of silently stamping a wrong ref into the chain.
  - **#9 reuse:** documented the ADA-sentinel/group-by-policy convention shared with
    `Value`/`apply_assets`/`txbuild::value`.
  **Proven live:** a 3-tx chain across 2 pools in one pass (cap=1) — pool `1c3be7b9` drained
  over 2 within-pool batches (`b8eb3b2f`→`477d7b51`, the 2nd on pruned `resolved`+`next_pool`)
  then pool `a2c6916e` (`b059d505`); pools moved by the exact sums (−20M ADA/+80M TEST and
  −11M/+40M). **81 tests** (+3: `expire_pending` TTL, `select_inputs` excludes pending,
  output-index layout), clippy -D + fmt clean.
- **2026-06-01** — **Within-pool batch splitting (configurable cap) — a single hot pool
  drains across k chained txs.** Completed the chaining follow-up. New deployment-JSON
  field **`max_orders_per_tx`** (serde default **20**, clamped ≥1; env override
  `SHASWAP_MAX_ORDERS_PER_TX` for tuning/testing) caps orders per settlement tx. A pool
  with more settleable orders than the cap is now drained over **k chained txs**, each a
  capped batch **re-solved against the previous batch's pool-continuation output** (the
  pool state rolls within the pool, not just across pools). Mechanics: `solver-core` gained
  `solve_capped(orders, pool, max_orders)` (`solve` = uncapped convenience over it; the cap
  just stops including past `max_orders`, still re-verified by the pin generator + k-check);
  `assemble::build_signed` now also returns the **pool-continuation output's `ResolvedUtxo`**
  (with its inline `PoolDatum`), so the next batch spends it as its pool input AND resolves
  it at the gate via `additionalUtxo`; the orchestrator's `settle_pool` loops capped batches,
  threading both the change and the pool output into `ChainCtx.resolved`. Each batch settles
  ONE pool at ONE price (different batches of the same pool may clear at different prices —
  fine, they're separate settlements; everyone still ≥ floor). **Proven live:** posted 3
  same-pool orders, ran with cap=2 → pool `1c3be7b9` drained in **2 chained txs in one pass**
  — batch1 `45e59ea9` (2 orders, −28M ADA/+100M TEST) → batch2 `4721b4a0` (1 order, −14M
  ADA/+50M TEST) spending batch1's pool output; on-chain the pool moved by the **sum**
  (−42M ADA/+150M TEST) and only the final pool UTXO remains (intermediate consumed). The
  floor-too-high 45M order was correctly never included. Caveat (documented in the field
  doc): too high a cap can make a batch exceed the per-tx ex-unit/size budget → that tx fails
  and the pool is skipped until orders drop, so 20 is conservative. **78 tests** (+3: cap
  limits/uncapped-includes-more, cap-of-one valid, config default/override/clamp), clippy -D
  + fmt clean.
- **2026-06-01** — **🎉 TRANSACTION CHAINING LIVE — batcher drains ALL settleable pools
  in one pass (was one-pool-per-block).** The reference solver now builds a **chain** of
  settlement txs per pass — one per settleable pool — each funded by the previous tx's
  **change output**, gated, and submitted back-to-back into the mempool, instead of
  ceding throughput by settling a single pool per block. **Proven live, end-to-end:**
  a 2-pool chain — tx1 `dd7342f6…` (pool `1c3be7b9`, price 3/10) → tx2 `1bad4abd…`
  (pool `a2c6916e`, price 7/20) — built+gated+submitted in **one pass**, tx2 funded by
  tx1's still-unconfirmed change. **On-chain audit:** pool1 −30M ADA/+100M TEST, pool2
  −35M ADA/+100M TEST; user (floor-protected, no fee) got 32M & 37M ADA; **solver net =
  Σtips 4,000,000 − Σfees 893,151 = +3,106,849** (exactly the terminal change output);
  solver TEST unchanged. The two hard pieces:
  - **Resolved-UTXO tracker + Ogmios `additionalUtxo`.** When tx N funds itself from tx
    N-1's change, that input isn't on-chain, so `evaluateTransaction` can't resolve it
    from ledger state. New `backend::ResolvedUtxo` (ref+address+value+inline-datum);
    `ChainBackend::evaluate(tx, additional)` now takes the not-yet-confirmed ancestors and
    serializes them into Ogmios v6 `additionalUtxo`. **Schema captured live, not guessed**
    (strict-validation curl probing → fixture `chain/tests/fixtures/ogmios-evaluate-additional-utxo.json`):
    `{transaction:{id}, index, address, value:{ada:{lovelace}, <policyHex>:{<nameHex>:qty}}, datum?}`
    — a malformed entry is rejected with JSON-RPC −32600 *before* the tx decode; `value`
    must be the nested object form. `assemble::build_signed` now takes `additional` and
    returns the change output's `ResolvedUtxo` (ref = this tx's hash + change index).
    The orchestrator threads a `ChainCtx{funding, collateral, resolved}`: rolling funding
    starts at the on-chain funding UTXO then becomes each tx's change; `resolved`
    accumulates every in-flight change to feed the next gate. Works in dry-run too (whole
    chain built+gated without submit — verified both txs pass with `additionalUtxo`).
  - **Collateral across a chain → SHARED works (verified live, decided + documented).** A
    phase-2-passing tx never consumes its collateral, so it stays in the mempool UTXO set;
    both chained txs reused the on-chain 5-ADA collateral `5fda1b6d#0` and it remained
    **unspent** after both confirmed. No rolling-collateral machinery needed (the EvaluateTx
    gate guarantees phase-2 success, so the shared collateral is never at risk). Each
    settlement tx still settles exactly ONE pool (one price+pool_nft per `SettlementRedeemer`).
  - **Economically-rational order selection.** A tx whose tips don't cover its fee
    (+`FEE_COVER_MARGIN`, default 0 = break-even floor) is skipped and its orders defer to a
    better-amortized batch — keeping solver-core's "never emit a settlement the chain
    rejects" property. Under load many small tips amortize one fee.
  **75 tests** (+4: `ResolvedUtxo`/`Value`→Ogmios-JSON serializers vs the captured shape),
  clippy -D + fmt clean. The one-pool fallback path is retained (a failed/fee-negative link
  just doesn't advance the chain; the next pool retries from the same funding).
  **Follow-up done same day** (see the entry above): configurable `max_orders_per_tx` cap +
  within-pool batch splitting. Remaining: surplus-max solving (§5.2.7).
- **2026-06-01** — **Fee handling verified with a separate USER key (not batcher-vs-itself).**
  Added a distinct trader wallet (`testnets/keys/user.skey`, OUTSIDE the repo; guarded
  exports in `env.sh`; scripts `happy_path/u1-setup-user.sh` gen+fund, `u2-post-user-order.sh`
  user-owned/-signed order) so tests reflect prod: users post orders, the solver batches.
  **Audited settlement `2ad42544…` on-chain** (user order, settled by the solver): inputs =
  {order (script-spent via `Settle`, NO user sig), pool, **solver funding**} — **no user-wallet
  UTXO is an input**; fee **446,694 paid entirely from the solver side**; settlement signed
  ONLY by the solver. Split: **user** receives +37,000,000 (floor 35M + min-ADA 2M), pays
  nothing for settlement (only their order-creation fee + the 2 ADA tip locked in the order);
  **solver** net = tip 2,000,000 − fee 446,694 = **+1,553,306**. Confirms the invariant:
  solver reward = tips, solver pays the settlement fee, user is floor-protected and posts
  offline (no settlement signature needed). Bonus: the user's first order (floor 45M) went
  **unsettled** because pool1's price had drifted below it — per-order floor protection,
  live (the batcher refuses to settle below floor). Keys stay out of the repo; scripts +
  env guard committed.
- **2026-06-01** — **🎉 Batcher generalized to ANY number of pools (zero-config) + real
  logging.** The reference solver is now turnkey for the protocol's arbitrary-pairs design:
  deploy, send ADA to the solver address, run — it discovers everything. **Multi-pool:**
  `ChainBackend::find_pools` returns every pool at the pool address (each self-describes its
  pair + NFT via its `PoolDatum` — verified it holds the NFT it declares — so NO per-pool
  config; `find_pool(nft)` is now a convenience default over it). `Snapshot.pools: Vec`. The
  orchestrator groups orders by `order.datum.pool_nft`, and `settlement_plan` (pure,
  unit-tested) picks which pools to attempt — sorted + **round-robin rotated by a cursor so
  none is starved** — and flags orphan orders (target a pool not on-chain; logged, never
  settled). Settles **one pool per block** (a settlement tx carries one price+pool; one tx
  keeps the single funding+collateral pair conflict-free), so K pools clear over ~K blocks.
  **Logging:** added `tracing` + `tracing-subscriber` (timestamps, levels, `RUST_LOG`);
  idle/junk-skip → debug, passes/submits → info, failures → warn/error. **Proven live with
  TWO pools:** stood up a 2nd TEST/ADA pool (`happy_path/04b-create-second-pool.sh`, new
  one-shot NFT `a2c6916e…`, reserves 500e6/300e6), posted an order for each, ran the daemon
  → block 1 settled pool `1c3be7b9` at price 9/20 (tx `9c0a0f02…`), block 2 settled pool
  `a2c6916e` at price 2/5 (tx `1e9a2bf3…`), each pool moving by exactly its order's fill.
  **71 tests, clippy -D + fmt clean.** Remaining (deferred): parallel multi-pool per block
  (needs multi-funding/UTXO pool), surplus-max solving (§5.2.7), Ogmios chain-sync WS push.
- **2026-06-01** — **Batcher loop is now block-driven (was a blind timer).** Chain state
  only changes on a new block, so the daemon now does a settle pass exactly when **Kupo's
  checkpoint advances** rather than every N seconds. `SHASWAP_INTERVAL_SECS` is reinterpreted
  as the cheap checkpoint-poll cadence; between blocks the loop only hits Kupo's
  `/checkpoints` (tiny) and does no discover/settle work. Keying off *Kupo's* checkpoint
  (not the Ogmios node tip) also closes a read-stale-data race — it guarantees Kupo has
  indexed the block before we read it. Added `kupo_ogmios::parse_kupo_checkpoint` +
  `KupoOgmios::kupo_checkpoint` (GET `/checkpoints`, newest-first; fixture-tested). Loop
  fires on `last != cp` so it also re-passes on a rollback. **Proven live:** ran the daemon
  (poll 5s) with no orders; over ~90s it polled ~18× but ran only **3 passes — one per new
  block** (tip 124659762→…796→…854); posted an order mid-run and it settled on the block
  Kupo indexed it (tx `0dfedf07…`), reusing the self-provisioned 5-ADA collateral
  (`5fda1b6d#0`) — confirming steady-state self-maintenance. Future optimization (noted, not
  done): Ogmios chain-sync over WebSocket for true push instead of checkpoint-polling.
  **67 tests, clippy -D + fmt clean.**
- **2026-06-01** — **Batcher turnkey collateral self-provisioning.** Decision (user):
  the reference solver should be turnkey — an operator just funds the solver address
  with ADA (any shape) and the batcher manages its own UTXOs. Key insight: a settlement
  needs a funding input AND a *distinct* collateral input (Cardano forbids one UTXO being
  both), so ≥2 wallet UTXOs are required — but **steady-state the wallet self-maintains**
  (each settlement regenerates the funding-change UTXO; collateral is never spent on
  success thanks to the EvaluateTx gate). The only gap was **bootstrap from a single
  lump**. Added `assemble::build_collateral_split` (a plain no-script tx carving a 5-ADA
  pure collateral + change, two-pass size fee) and `orchestrator::ensure_collateral`
  (runs once at startup: if `select_inputs` can't find funding + a distinct collateral,
  and `SHASWAP_SUBMIT=1`, it splits the largest UTXO, submits, and waits for confirmation;
  in dry-run it errors with guidance). 5-ADA collateral is fixed by `COLLATERAL_LOVELACE`
  and exceeds the worst-case requirement. **Proven live:** consolidated the test wallet to
  one lump (`17465045…#0`), ran the batcher → it auto-split (tx `5fda1b6d…`: out#0 =
  5,000,000 pure ADA collateral, out#1 = change incl. TEST), confirmed, then settled.
  **66 tests, clippy -D + fmt clean.** Remaining batcher follow-up: multi-funding when a
  single funding UTXO can't cover a very large batch's fee (not reachable in v1); surplus-max
  solving (deferred §5.2.7).
- **2026-06-01** — **Batcher: atomic single-fetch discovery + continuous loop mode.**
  Worked the deferred review items. (1) **`ChainBackend::discover`** — new trait method
  (default = the 3 separate queries; `KupoOgmios` overrides with ONE `/matches/*?unspent`
  partitioned by address) returning a `Snapshot{orders,pool,wallet}`: a third of the Kupo
  round-trips per pass AND an atomic view (the three sets can't drift mid-pass). Factored
  the per-match decoders (`try_order` skips+logs junk, `try_pool` requires NFT+valid datum,
  `wallet_utxo`) so `find_orders/find_pool/find_wallet_utxos` and `discover` share them.
  (2) **Loop mode** — `orchestrator` now loops when `SHASWAP_INTERVAL_SECS=<n>` is set
  (else one-shot); a transient pass failure logs+retries instead of killing the daemon; an
  **in-flight set** tracks just-submitted order refs and excludes them until they drop out
  of discovery (confirmed), so it never double-spends an order still in the mempool.
  **Proven live:** loop settled order `ee12167e…` (tx `e0d1e038…`, pool −45M), then reported
  "nothing to settle" on subsequent passes; the parked junk UTXO (`2279ae9b…`) is skipped
  every pass. (3) Confirmed the **collateral** review finding is unreachable: the flat 5-ADA
  floor exceeds the worst-case requirement (max-fee × 150% ≈ 3.99 ADA, fee bounded by max
  ex-units + max tx size) — documented in `select_inputs`, no machinery added. Updated
  `batcher/README.md` (orchestrator usage + status). **66 tests, clippy -D + fmt clean.**
  Remaining batcher follow-ups: multi-funding/auto-split when <2 pure-ADA UTXOs; surplus-max
  solving (deferred §5.2.7).
- **2026-06-01** — **Code-review fixes (batcher).** Acted on a high-effort review of the
  batcher diff. (1) **Griefing fix (find_orders):** the order script address is public, so
  anyone can park a datumless/junk-datum UTXO there; the old `find_orders` returned `Err`
  on the first undecodable UTXO → one bad UTXO bricked every settlement. Now it **skips +
  logs** non-OrderDatum UTXOs (only a transport error propagates). **Proven live:** parked
  a junk inline-datum UTXO (`2279ae9b…#0`) at the order address, posted a real order, and
  the batcher logged `skip order utxo …: not a valid OrderDatum` then settled the real one
  (tx `76f8cf6a…`); the junk stays parked + permanently ignored. (2) **Hard-fail on missing
  ex-units (assemble::build_signed):** after EvaluateTx it now verifies every script input
  (pool + each order) got a budget, erroring clearly instead of silently building a
  zero-budget redeemer the node would reject phase-2 (the draft still uses zeros by design).
  (3) **Reuse:** replaced the three hand-rolled hex codecs in `kupo_ogmios`/`orchestrator`
  with the already-present `hex` crate. **Deferred (noted in review, low value/edge):**
  single-fetch discovery (3× `/matches/*` per pass — only matters once it's a loop),
  collateral sizing vs fee×collateral-percentage (only large batches), the 3× `build_staging`
  encode. **66 tests, clippy -D + fmt clean.**
- **2026-06-01** — **🎉 LIVE TWO-SIDED NETTING settlement (Rust batcher) — pool
  untouched.** Settlement tx
  `4e12d57fa928191ce4383a17db916c1c227aea7fd1cf7a6f83b9f6a4482f0b18` cleared a
  token-seller (A: sell 100M TEST, floor 45M ADA) AND an opposing ADA-seller (B: sell
  50M ADA, floor 90M TEST) in ONE tx at uniform price **1/2**, `net_a=0 net_b=0`. Verified
  on-chain: A's owner got 52M ADA (4M order + 50M received − 2M tip, 0 TEST); B's owner
  got 2M ADA (min) + 100M TEST; **pool delta EXACTLY 0/0** (ada 861,338,911, test 1.2e9,
  NFT+LP+datum identical before/after) — the coincidence-of-wants cleared user-to-user
  with the AMM providing zero liquidity (no slippage, no fee); solver took only the 4M
  tips. This is the MEV-resistant batch-auction win on chain. N=2: ex-units mem≈1.28M
  steps≈482M, fee 480,534, 1256-byte tx — comfortably inside the per-tx budget (head-room
  confirms the ~40-order ceiling). Added `happy_path/05b-post-ada-order.sh` (sell_a=False,
  ADA triple-role: order holds sell+min+tip lovelace). No Rust change — the orchestrator
  handled N=2 unchanged. **Batcher reference-solver milestone complete:** discover→solve→
  assemble→evaluate→submit works live for one-sided AND netting settlements.
- **2026-06-01** — **🎉 FIRST FULLY-PROGRAMMATIC LIVE SETTLEMENT — the Rust batcher
  reproduces `06-settle.sh` end-to-end.** Settlement tx
  `05d990637b95dc056262683be7049fad27128690afe1948f7bd4711c5776dbf9` built, evaluated,
  signed, and submitted by the **orchestrator** (`crates/orchestrator`, bin
  `shaswap-batcher`) — discover (Kupo) → solve (`solver-core`) → assemble (withdraw-0
  Conway tx) → **EvaluateTx gate** (Ogmios accepts phase-2) → submit. Verified on-chain:
  order `fb4bacae…#0` (sell 100M TEST, floor 50M ADA, tip 2M) consumed; **owner** paid
  52,000,000 (4 ADA order + 50 ADA received − 2 ADA tip, TEST fully sold, inline
  BoundDatum); **pool** moved ADA 911,338,911→861,338,911 (−50M), TEST 1.1e9→1.2e9
  (+100M), NFT+full LP+datum preserved; **solver** took the 2 ADA tip into its change.
  Solver picked price 1/2 = the order's own floor (v1 floor-only routes a one-sided
  residual at the boundary — user gets ≥ floor, pool keeps surplus; netting is the real
  win, see task 5). ex-units mem≈980k steps≈363M, fee 446,242, 1064-byte tx.
  **Body assembler** = `chain::assemble` (drives the `shaswap-txbuilder` fork):
  inputs(orders+pool+funding) + collateral + 3 ref-script reference inputs; outputs
  owners[0,N)→pool→remainders→**solver change LAST** (change computed by us — the fork
  doesn't auto-balance); withdraw-0 `S` + redeemers; **two-pass flow** draft(exu 0)→
  EvaluateTx fills per-redeemer ex-units (mapped back by canonical sorted index)→fee
  (script-exec + tiered ref-script[7347 B] + size + margin)→rebuild→sign (loads the
  cardano-cli `5820…` ed25519 skey). **Key bug found & fixed live:** `build_staging`
  computed change from the fee but never set the tx `fee` field → first submit hit
  `code 3122 providedFee:0`; added `.fee(fee)`. (Benign: the fork stores redeemers in a
  HashMap, so the redeemer-list order — hence tx_hash — varies run-to-run; still valid,
  self-consistent script_data_hash.) Orchestrator guards submit behind `SHASWAP_SUBMIT=1`
  (else dry-run build+evaluate, for cross-checking). **66 batcher tests, clippy -D + fmt
  clean.** **Next:** task 5 — two-sided NETTING (post an ADA-seller + TEST-seller, settle
  both in one tx; pool moves only by the residual).
- **2026-06-01** — **Batcher live transport: Kupo+Ogmios `ChainBackend` (chain crate).**
  Wired the live provider behind the existing trait (`crates/chain/src/kupo_ogmios.rs`,
  dep `ureq` blocking HTTP + `pallas-addresses`). Ogmios JSON-RPC :1337 → `tip`
  (`queryNetwork/tip`), `protocol_params` (`queryLedgerState/protocolParameters` — now
  also carries the **PlutusV3 cost model** [350 ints] for `language_views` + the Conway
  **reference-script tiered fee** params), `evaluate` (`evaluateTransaction` = the
  pre-submit gate), `submit`. Kupo REST :1442 → discovery. **Real-JSON gotchas (verified
  live, not guessed):** (1) Kupo rejects full-address path patterns (`/matches/<addr>` →
  "invalid pattern") — query `/matches/*?unspent` (returns only the configured bounded
  set: S-tagged order/pool + solver wallet) and filter by address client-side; (2) inline
  datums come back by hash — fetch CBOR via `/datums/{hash}` → `{"datum":"<hex>"}`;
  (3) Ogmios prices are `"num/den"` strings, cost models keyed `plutus:v3`. Extended
  `ProtocolParams` (+cost_model_v3, +ref_script_{base,range,multiplier}); added
  `fees::reference_script_fee` (tiered), `Value::is_ada_only`, `backend::Utxo` +
  `find_wallet_utxos` (funding/collateral selection), `txbuild::address::shelley_bech32`.
  JSON parsing is factored into pure fns unit-tested against **captured live fixtures**
  (`crates/chain/tests/fixtures/`); a `#[ignore]` live suite (`tests/live.rs`) hit the
  running services and confirmed: tip slot, params (350-entry V3 model), **find_pool** →
  `6cbd9061…#1` (ADA 911,338,911, TEST 1.1e9, NFT+LP, asset_a=TEST), wallet (6 UTXOs,
  1 pure-ADA). **64 batcher tests, clippy -D + fmt clean.** Launch scripts:
  `happy_path/run-ogmios.sh`, `run-kupo.sh` (matches `*/S_HASH` + solver addr; first run
  `--since origin` to capture the pre-existing pool, then resumes from checkpoint).
  **Next:** body-assembly glue (Settlement → StagingTransaction) + orchestrator loop;
  note only **1 pure-ADA UTXO** in the solver wallet now → funding can be the TEST-bearing
  UTXO (leftover returns as change), collateral = the 6.59-ADA pure UTXO.
- **2026-06-01** — **🎉 FIRST LIVE SETTLEMENT on preprod — the full design works on
  chain.** Settlement tx `6cbd9061426e1b9fb98998baae155fe1e3c54f95186ff1f9e859e8e5abfdb4da`
  settled one token-seller order against the pool via the **withdraw-0 anchor** +
  reference scripts, passing phase-2. Verified on-chain: order consumed; pool moved
  EXACTLY to the pins (TEST 1e9→1.1e9 in, ADA 1,002,000,000→911,338,911 out, NFT+full LP
  preserved, datum intact); owner paid 92,661,089 lovelace (90,661,089 received + 2 ADA
  min) with the `BoundDatum`; solver took the 2 ADA tip. Exercised: order `Settle`, pool
  `PoolSettle`, settlement withdraw-0 (`SettlementRedeemer` w/ price+fills), per-order
  floor, pool k-with-fee, injective binding, M-01/L-01 output pins. Built with cardano-cli
  (pins computed the same way solver-core does — `received = swap_out` floor, price =
  received/sell); `happy_path/06-settle.sh`. **Live deployment identities** (also in
  `happy_path/deployment.json`, matches `chain::Config`): S `82039119…`, order
  `65261b26…`, pool `dfa55af0…`, pool_mint policy `1c3be7b9…`, TEST token `8160c878…`
  (name `54455354`), reference scripts all in tx `032ded5d…` (settlement#0, pool#1,
  order#2). **Next:** wire the Rust batcher to reproduce this programmatically
  (Ogmios/Kupo backend + the shaswap-txbuilder fork + solver-core pins), then a
  netting (two-sided) settlement.
- **2026-06-01** — **CRITICAL deploy fix → Blueprint Rev 20: settlement anchor must
  authorize its own registration.** Found while bootstrapping preprod (cardano-node 11,
  Conway PV10): registering `S` (the settlement script's hash, a *script* stake
  credential) **invokes the settlement staking script for the `Certifying`/`publish`
  purpose** — the node rejects an unwitnessed reg with `MissingScriptWitnessesUTXOW [S]`,
  and witnessing it ran the script which hit `else -> fail`. So the original anchor was
  **undeployable**: `S` could never be registered, and withdraw-0 requires a registered
  reward account. Fix: added a `publish` handler to `validators/settlement.ak` →
  `clearing.allow_registration(cert)` permitting **only** `RegisterCredential`, rejecting
  de-registration + delegation → `S` is registerable by anyone yet **immortal +
  undelegatable**. Verified live: registration tx `58ad2146…` succeeds WITH the handler
  (failed without). Ripple: settlement hash `S` changed (now
  `82039119bc85e1b8fb4fab8cfb0628f487e64f0b6338da842950500c`), hence new order hash
  `65261b26…`, pool hash `dfa55af0…`, and all tagged addresses. No change to clearing
  logic or any Rust crate (the batcher never publishes certs; bootstrap does). Couldn't
  unit-test (`RegisterCredential.deposit: Never` is impractical to construct) — validated
  on-chain. 96 aiken tests still green.
- **2026-06-01** — **Live preprod bootstrap started (`contracts/happy_path/`).** Node at
  `testnets/node-preprod` (socket `db-testnet/node.socket`), synced, Conway, magic 1.
  Installed prebuilt **Ogmios v6.14.0 + Kupo v2.11.0** to `testnets/bin/` (the batcher's
  ChainBackend; cardano-cli 11 + aiken 1.1.22 also present). Solver/bootstrap key at
  `testnets/keys/solver.skey` (OUTSIDE the repo, never committed), addr
  `addr_test1vq6vymyr2plj92javazvvxfqj5aaqxhk5u3u87ud4dc8u5gyasnly`, funded 10k tADA.
  `happy_path/` holds `env.sh` (paths/identities/constants), `scripts/` (param-applied
  `.plutus` envelopes + tagged order/pool addresses + S stake addr), numbered bootstrap
  scripts. **Done:** UTXO split, S registered. **Next:** mint test token, deploy
  reference scripts, create+seed pool, post orders, launch Ogmios+Kupo, live settlement.
  `happy_path/work/` (tx drafts, pparams) is gitignored.
- **2026-06-01** — **Batcher `chain` foundations (chain access).** New `chain` crate
  (solver-core, txbuild, pallas-primitives/codec, serde/serde_json). Modules:
  `backend` (the `ChainBackend` trait — tip/params/find_orders/find_pool/evaluate
  [the EvaluateTx pre-submit gate]/submit — the one swappable provider seam per the
  data-access rule), `config` (typed fail-fast `Config`; `validate()` rejects malformed
  hex AND any constant drifting from `constants.ak` — binds the pool NFT, parses ref
  scripts; from JSON via serde), `decode` (on-chain Plutus Data → solver-core datums,
  the **inverse of `txbuild::plutus`, round-trip tested** so encoder/decoder can't
  drift; handles bignum + neg-bignum), `fees` (pure body-finalization arithmetic:
  script-exec fee from ex-units+prices, size fee, ex-unit sum, POSIX→slot floor). 13
  chain tests green; **50 batcher tests total**, clippy `-D warnings` clean.
  **Deliberately NOT built (needs a live node; not fixture-tested blind to avoid false
  confidence in guessed JSON shapes):** the Kupo/Ogmios HTTP transport + the final body
  stitch (funding/collateral, tip-change, script_data_hash over cost models, fee
  balancing, signing) + the orchestrator loop. Those are the next concrete step,
  gated by the bootstrap dependency.
- **2026-06-01** — **Forked pallas-txbuilder for withdraw-0 (new `shaswap-txbuilder`
  crate).** Resolved the earlier blocker by vendoring pallas-txbuilder 1.0.0 source into
  `batcher/crates/txbuilder` (Apache-2.0, attributed in lib.rs) and adding the missing
  withdrawal/reward-redeemer support — the ShaSwap anchor is a withdraw-0 staking script
  and is otherwise unbuildable. Surgical additions (all tagged "ShaSwap fork"):
  `StagingTransaction.withdrawals` field + `.withdrawal()`/`.remove_withdrawal()`/
  `.add_withdraw_redeemer()` builders, `RedeemerPurpose::Reward(Vec<u8>)`, the body
  `withdrawals` BTreeMap, the `Reward` redeemer arm (index = account's position in the
  canonical withdrawals order), and `"withdraw:{hex}"` (de)serialization. `build_conway_raw`
  already computes `script_data_hash` from language views and does NOT balance fees/
  ex-units (matches our chain-layer split). Proof test (`tests/withdraw.rs`): builds a
  withdraw-0 + reward redeemer, re-decodes the CBOR, asserts the body withdrawal + the
  Reward redeemer at index 0; a dangling reward redeemer (no matching withdrawal) is
  rejected. Vendored crate is exempt from our `-D warnings` profile (`[lints.clippy]
  all=allow`); our authored crates stay clean. **54 batcher tests total.** Track upstream
  for unrelated fixes; our diff vs 1.0.0 is just the tagged additions.
- **2026-06-01** — **Batcher `txbuild` skeleton (chain-independent tx building).**
  New `txbuild` crate (pallas-primitives/codec/crypto/addresses). Modules: `plutus`
  (every datum/redeemer → Plutus Data matching `plutus.json` constructor indices/field
  order exactly — byte-verified: Settle/PoolSettle = `d87980`, ADA AssetId =
  `d8799f4040ff`; round-trip decode), `address` (solver Address/Credential → raw
  Cardano address bytes + reward account for `S`), `value` (solver Value → Conway
  `Value` coin+canonical multiasset), `plan` (`plan()` → canonical outputs [owners,
  pool, remainders] + script spends [Settle/PoolSettle] + withdraw-0 account/redeemer +
  POSIX validity bound; `compute_redeemers()` assigns Spend/Reward indices against the
  FINAL canonically-sorted input/withdrawal set — so it composes with the funding inputs
  chain adds). 14 txbuild tests green; clippy `-D warnings` clean. **Key finding:
  `pallas-txbuilder` 1.0 CANNOT build a ShaSwap settlement — only Spend/Mint redeemers,
  no withdrawals/reward-redeemer purpose** (the anchor is a withdraw-0 staking script),
  so the body is hand-rolled on the Conway `pallas-primitives` model. **Deliberately
  deferred to `chain` (needs protocol params + a node, can't be tested offline):** the
  final body stitch — funding/collateral inputs, tip-change output, POSIX→slot `ttl`,
  `script_data_hash` from cost models, ex-units via EvaluateTx, fee balancing, signing.
  Conway `TransactionOutput`/`WitnessSet` use decode-oriented `KeepRaw<'b>` lifetimes;
  the plan stores OWNED output components (addr bytes + Conway Value + inline-datum CBOR)
  to sidestep them — chain assembles the concrete borrow-typed body.
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
