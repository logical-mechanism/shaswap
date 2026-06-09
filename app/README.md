# ShaSwap — web app (`app/`)

The website / dApp for **ShaSwap**, a non-custodial, MEV-resistant batch-auction DEX on
Cardano (eUTXO). The app builds order and liquidity intents client-side and signs them
with the user's wallet — it never holds keys, and it never settles batches (that's the
untrusted solver's job; see [`../batcher/`](../batcher)). Design source of truth:
[`../documentation/BLUEPRINT.md`](../documentation/BLUEPRINT.md); contributor guidance:
[`../CLAUDE.md`](../CLAUDE.md).

**Live on mainnet and preprod.** Connect a wallet to swap (post + reclaim orders), provide liquidity
(add/remove, either directly or via batcher-fulfilled intents), and create or close
pools — all non-custodial. Reads (pools, tokens, quotes, your orders) come through a
swappable data seam.

## Stack

- **Next.js 16** (App Router) + **TypeScript** (strict) + **Tailwind v4**, bundled with
  **Turbopack** (resolves MeshJS's WASM natively).
- **MeshJS** — `@meshsdk/react` (wallet hooks, `CardanoWallet`) + `@meshsdk/core`
  (`MeshTxBuilder`, `BlockfrostProvider`, datum (de)serialization, `core-cst`).

> **`@meshsdk/react` is pinned to `1.9.0-beta.98` on purpose** — there is no stable
> `1.9.0` published, and the app relies on 1.9.x hook behavior matching
> `@meshsdk/core@^1.9.0` (the `scriptSize`/`txIn` handling in
> [`src/lib/client/tx.ts`](src/lib/client/tx.ts)). Any bump must be re-verified
> end-to-end on preprod, since the write paths aren't covered by unit tests.

## Run

```bash
cd app
nvm use                       # Node 22 (see .nvmrc)
npm install
cp .env.example .env.local    # paste a PREPROD Blockfrost project id
npm run dev                   # http://localhost:3000
npm run build                 # production build (type-checked)
npm run lint                  # eslint (must be clean)
npm run test                  # Node test runner — encoding + order + address pins
```

### Environment (`.env.local`)

- **`BLOCKFROST_PROJECT_ID`** — **server-only** (read only in route handlers, never sent
  to the browser). When set, the data seam uses Blockfrost; unset, it falls back to an
  offline `MockProvider`. **Its network prefix must match `NEXT_PUBLIC_NETWORK`** — the
  app refuses to start on a mismatch.
- Optional: `DATA_PROVIDER` (`blockfrost` | `mock`), `NEXT_PUBLIC_NETWORK`
  (`preprod` | `preview` | `mainnet`, default `preprod`), `LOG_LEVEL`.

## Network — one knob

Network is a single config value — `APP_CONFIG.network` (from `NEXT_PUBLIC_NETWORK`,
default `preprod`). The same build serves preprod / preview / mainnet. Per-network
identities (order/pool addresses, reference-script UTXOs, the `deployed` flag) live in
[`src/lib/chain/deployment.ts`](src/lib/chain/deployment.ts); everything
network-independent (script hashes, compiled code, constants) is shared, and the
addresses are pinned by [`address.test.ts`](src/lib/chain/address.test.ts).

> **Mainnet is live** (`deployed: true`, since 2026-06-08; reference scripts published in
> deploy tx `d56e729c…`), and `app.shaswap.org` runs `NEXT_PUBLIC_NETWORK=mainnet`. On a
> network that *isn't* deployed (preview), the app still reads (scans come back empty) and
> tx-building throws a clear error instead of crashing.
> See [`../documentation/launch/mainnet-checklist.md`](../documentation/launch/mainnet-checklist.md).

## Deploy (DigitalOcean App Platform)

Two apps off the same repo, one per network — specs in [`.do/`](../.do). Build is the DO
Node.js buildpack (`npm ci && npm run build` → `npm run start`); a push redeploys. The
one detail that bites: **env-var scope.** `NEXT_PUBLIC_*` must be `RUN_AND_BUILD_TIME`
(inlined into the client bundle at build); `BLOCKFROST_PROJECT_ID` must be a `RUN_TIME`
secret (server-only). A wrong scope ships a broken bundle.

## The data-access rule (inviolable — see [`../CLAUDE.md`](../CLAUDE.md))

**Every chain read goes through ONE swappable abstraction.** No component, hook, or route
handler calls a provider SDK directly, and no provider SDK (or its key) runs in the
browser. Transactions are built and signed client-side via the wallet, but any chain
queries the build needs (protocol params, tx evaluation, UTXO resolution) also go through
our own `/api/*`.

```
React → hooks → client (api/tx) → our /api/* routes (server) → getDataProvider() → DataProvider
                            └─ wallet (CIP-30) for build + sign
```

- Interface: [`src/lib/data/provider.ts`](src/lib/data/provider.ts).
- Real provider: [`src/lib/data/blockfrost.ts`](src/lib/data/blockfrost.ts) — finds pools
  generically (a UTXO is a pool iff it holds the NFT its own `PoolDatum` declares, mirroring
  the batcher), so there's no per-pool config.
- Mock: [`src/lib/data/mock.ts`](src/lib/data/mock.ts) — offline fallback for dev with no key.
- **Swapping the source** (e.g. to a self-hosted Dolos node) is a one-file change:
  implement `DataProvider` and return it from `getDataProvider()`. Nothing else changes.

## On-chain encoding

The datum/redeemer encoding must match the contracts exactly. The TS codec
[`src/lib/chain/datums.ts`](src/lib/chain/datums.ts) mirrors `contracts/plutus.json` and
the batcher's encoder; MeshJS produces byte-identical CBOR, pinned by tests
([`datums.test.ts`](src/lib/chain/datums.test.ts), [`order.test.ts`](src/lib/chain/order.test.ts),
[`address.test.ts`](src/lib/chain/address.test.ts)). A malformed order throws in
`buildOrder` — it is never silently posted.

## Layout

```
src/
  app/
    page.tsx               /               swap card (post an order)
    orders/page.tsx        /orders         your live orders + reclaim
    pools/page.tsx         /pools          pool list (via the seam)
    pools/create/page.tsx  /pools/create   create a pool
    pools/[id]/page.tsx    /pools/[id]     pool detail + add/remove liquidity
    terms, privacy                         legal pages
    api/*/route.ts                         server-side reads + tx-build support
  components/  swap/  pools/  wallet/  legal/  (+ shared UI)
  hooks/       useTokens / usePools / useQuote / useOrders / useLpIntents
  lib/
    config.ts              network + explorer links
    chain/                 on-chain encoding (deployment, datums, order, address) + tests
    client/                api.ts (reads), tx.ts (order / LP / pool write paths via wallet)
    data/                  provider.ts, index.ts (the swap point), blockfrost.ts, mock.ts
```

## Not in the app (by design)

- **Settlement / batch clearing** — the untrusted solver's job ([`../batcher/`](../batcher)).
- The on-screen quote is a constant-product **estimate**, not the protocol's uniform-price
  clearing — you post an intent and a solver settles it later, never below your floor.
- Token metadata/icons (tickers come from the asset name; non-ADA decimals default to 0)
  and settled-order history (only live orders are listed).
```

