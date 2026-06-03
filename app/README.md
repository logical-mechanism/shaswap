# ShaSwap — Web App (`app/`)

The website / dApp for **ShaSwap**, a non-custodial, MEV-resistant batch-auction
DEX on Cardano (eUTXO). See the repo root [`CLAUDE.md`](../CLAUDE.md) and the
authoritative design in [`documentation/BLUEPRINT.md`](../documentation/BLUEPRINT.md).

> **Status: live on preprod (read + post + reclaim).** The app reads real preprod
> pools/orders/quotes through the data seam, and lets a connected wallet **post** an
> order and **reclaim** its own order — both non-custodial (the wallet signs; the app
> never holds keys). It does **not** settle/clear batches; that is the untrusted
> solver's job (the Rust `batcher/` already does it live).

## Stack

- **Next.js 16** (App Router) + **TypeScript** (strict) + **Tailwind CSS v4**
- **MeshJS** — `@meshsdk/react` (`MeshProvider`, `useWallet`, `CardanoWallet`,
  `useAddress`, `useLovelace`, `useNetwork`) + `@meshsdk/core` (`MeshTxBuilder`,
  `BlockfrostProvider`, `mConStr`/`deserializeDatum`, `@meshsdk/core-cst`)
- Bundler: **Turbopack** (Next 16 default; resolves MeshJS's WASM libs natively)

> **`@meshsdk/react` is pinned to `1.9.0-beta.98` on purpose.** There is no stable
> `1.9.0` of `@meshsdk/react` published (npm returns 404), and the app relies on
> 1.9.x React-hook behavior that matches `@meshsdk/core@^1.9.0` (notably the
> `scriptSize`/`txIn` handling the client tx builder depends on — see
> [`src/lib/client/tx.ts`](src/lib/client/tx.ts)). **Do not bump this blindly:** any
> change must be re-verified end-to-end on preprod (post order, reclaim, LP
> deposit/withdraw, create/close pool), since these paths can't be exercised by the
> unit tests. Pin to a stable `@meshsdk/react` as soon as one ships.

## Run

```bash
cd app
nvm use                 # Node 22 (see .nvmrc); NOT snap node (it swallows stdout)
npm install
cp .env.example .env.local   # then paste your Blockfrost PREPROD project id
npm run dev      # http://localhost:3000
npm run build    # production build (TypeScript-checked)
npm run lint     # eslint (must be clean)
npm run test     # Node test runner — Plutus encoding + order + address pins
```

### Environment (`.env.local`, gitignored)

- **`BLOCKFROST_PROJECT_ID`** — your Blockfrost project id. **Server-only:** it is read
  solely in `getDataProvider()` / route handlers and never reaches the browser, so it's
  safe as a plain server env var in deployment (e.g. DigitalOcean). When set, the data
  seam uses the real Blockfrost provider; when unset it falls back to the offline
  `MockProvider`. **Its prefix must match `NEXT_PUBLIC_NETWORK`** (`preprod…` ↔ preprod,
  `mainnet…` ↔ mainnet, …) — the app refuses to start on a mismatch.
- Optional: `DATA_PROVIDER` (`blockfrost` | `mock`), `NEXT_PUBLIC_NETWORK`
  (`preprod` | `preview` | `mainnet`, default `preprod`), `LOG_LEVEL`
  (`debug` | `info` | `warn` | `error`, default `info`).

See [`.env.example`](.env.example) for the template.

## Network

Network is **one config value** — [`src/lib/config.ts`](src/lib/config.ts)
`APP_CONFIG.network` (from `NEXT_PUBLIC_NETWORK`), default **preprod**. The CIP-30
`networkId` is derived from it, the header flags a wallet on the wrong network, and the
swap card refuses to post when the wallet network mismatches.

The same codebase serves **preprod / preview / mainnet** — pick the network per deploy.
The per-network deployment identities (order/pool addresses, reference-script UTXOs, the
`deployed` flag) live in [`src/lib/chain/deployment.ts`](src/lib/chain/deployment.ts),
keyed off `APP_CONFIG.network`; everything network-independent (script hashes, compiled
code, on-chain constants) is shared. Addresses are committed literals **pinned to the
canonical derivation for both networks** by
[`address.test.ts`](src/lib/chain/address.test.ts).

> **Mainnet is scaffolded but not yet live.** ShaSwap's contracts aren't deployed on
> mainnet, so `mainnet` has `deployed: false` (no reference-script UTXOs). On such a
> network the app still **reads** (pool/order scans just come back empty); tx-building
> goes through `requireDeployed()`, which throws a clear error instead of a null crash.
> To go live: deploy the reference scripts, fill `orderRef`/`poolRef` + set
> `deployed: true` in `deployment.ts`, and set `NEXT_PUBLIC_NETWORK=mainnet`.

## Deploy (DigitalOcean App Platform)

Two apps off the same repo/branch, one per network — committed specs in
[`.do/`](../.do):

| Spec | DO app | Domain | `NEXT_PUBLIC_NETWORK` |
|---|---|---|---|
| [`.do/app.preprod.yaml`](../.do/app.preprod.yaml) | `shaswap-preprod` | `preprod.shaswap.org` | `preprod` |
| [`.do/app.mainnet.yaml`](../.do/app.mainnet.yaml) | `shaswap` | `app.shaswap.org` | `preprod` → `mainnet` later |

The production app (`app.shaswap.org`) **shows preprod for now** and flips to mainnet
once the contracts are live (see the header of `app.mainnet.yaml` — flip the env, swap to
a `mainnet…` Blockfrost key, fill the refs in `deployment.ts`).

```bash
doctl apps create --spec .do/app.preprod.yaml     # once per app
# then set the BLOCKFROST_PROJECT_ID secret in the DO console
```

- **Build:** DO's **Node.js buildpack** (no Dockerfile). `npm ci && npm run build` then
  `npm run start`; Node comes from [`.nvmrc`](.nvmrc) / `engines`. `next start` honors the
  `$PORT` DO injects. `deploy_on_push: true` → every push to `main` redeploys both apps.
- **Env-var scopes are the crux** (a wrong scope ships a broken bundle):

  | Var | Scope | Why |
  |---|---|---|
  | `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_SITE_URL` | `RUN_AND_BUILD_TIME` | inlined into the client bundle **at build** — a run-time-only scope bakes the defaults |
  | `BLOCKFROST_PROJECT_ID` | `RUN_TIME` + `SECRET` | server-only; never needed (or wanted) at build |
  | `DATA_PROVIDER`, `LOG_LEVEL` | `RUN_TIME` | optional, explicit |

## The data-access rule (INVIOLABLE — see CLAUDE.md)

**Every chain read goes through ONE swappable abstraction. No component, hook, or
route handler calls a provider SDK directly — and no provider SDK (or its key) runs
in the browser.** Transaction BUILD/SIGN happens client-side via the wallet, but any
chain queries the build needs (protocol params, tx evaluation, UTXO resolution) go
through our own `/api/*` too.

```
 React components ─▶ hooks (src/hooks/*) ─▶ client (src/lib/client/{api,tx}.ts)
                                                   │  fetch() our OWN /api/*  +  wallet (CIP-30)
                                                   ▼
        Next route handlers (src/app/api/*/route.ts)  ◀── server-side only
                                                   │
                                                   ▼
        getDataProvider()  (src/lib/data/index.ts)  ◀── THE single swap point
                                                   │
                                                   ▼
                 DataProvider impl (BlockfrostDataProvider, or MockProvider)
```

- **The interface:** [`src/lib/data/provider.ts`](src/lib/data/provider.ts)
  (`DataProvider`): `listTokens / listPools / getPool / priceQuote /
  walletPositions` (reads) + `protocolParameters / evaluateTx / resolveUtxo`
  (tx-build support — all served through `/api/*` so the key stays server-side).
- **The real provider:** [`src/lib/data/blockfrost.ts`](src/lib/data/blockfrost.ts)
  discovers pools/orders at the `S`-tagged pool/order addresses and decodes their
  inline datums. Pools are identified **generically** (a UTXO is a pool iff it holds
  the NFT its own `PoolDatum` declares — mirroring the batcher's `find_pools`), so
  every pool is found with no per-pool config.
- **The mock:** [`src/lib/data/mock.ts`](src/lib/data/mock.ts) — offline fallback for
  dev with no key.

### Swapping the backing source (e.g. to our own Dolos node)

A **one-file change**: implement `DataProvider` in a new file under `src/lib/data/`
and return it from `getDataProvider()` in
[`src/lib/data/index.ts`](src/lib/data/index.ts) (keyed off `DATA_PROVIDER`). No
route handler, hook, or component changes.

## On-chain encoding (the make-or-break detail)

The order datum/redeemer encoding must match the contracts **exactly**. The TS codec
[`src/lib/chain/datums.ts`](src/lib/chain/datums.ts) mirrors `contracts/plutus.json`
and the batcher's pallas encoder (`batcher/crates/txbuild/src/plutus.rs`); MeshJS's
`mConStr`/`serializeData` produce **byte-identical** CBOR. The encoding is pinned by
tests ([`datums.test.ts`](src/lib/chain/datums.test.ts)) against the known fixtures
(`d87980`, `d8799f4040ff`, the full order datum), the order builder
([`order.test.ts`](src/lib/chain/order.test.ts)), and the order/pool addresses
([`address.test.ts`](src/lib/chain/address.test.ts)). **A malformed order throws in
`buildOrder` — it is never silently posted.** Deployment identities are mirrored in
[`src/lib/chain/deployment.ts`](src/lib/chain/deployment.ts) (from
`contracts/happy_path/deployment.json`).

> Tests run on Node's built-in runner with TS type-stripping (`npm run test`); they
> live in `*.test.ts`, excluded from the Next build + eslint, and use explicit `.ts`
> import specifiers (which the runner requires).

## Layout

```
src/
  app/
    page.tsx                / — the swap card (post an order)
    pools/page.tsx          /pools — real preprod pools (via the seam)
    orders/page.tsx         /orders — your live orders + Reclaim
    api/
      tokens|pools|quote|orders/route.ts   reads → DataProvider
      protocol-params/route.ts             GET  → provider.protocolParameters()
      tx/evaluate/route.ts                 POST → provider.evaluateTx(cbor)
      tx/utxo/route.ts                     GET  → provider.resolveUtxo(tx,index)
  components/swap/SwapCard.tsx             build/sign/submit an order intent
  hooks/                                   useTokens/usePools/useQuote/useOrders
  lib/
    config.ts                              network + explorer links
    chain/                                 on-chain encoding (decoupled from contracts/)
      deployment.ts   datums.ts   order.ts   address.ts   *.test.ts
    client/  api.ts (reads)   tx.ts (postOrder / reclaimOrder via wallet)
    data/    provider.ts  index.ts  blockfrost.ts  mock.ts  types.ts
```

## What's real vs still stubbed

**Real (live on preprod):**
- Reads — pools, tokens, quotes, and a wallet's orders, all from Blockfrost behind
  the seam (key server-side).
- **Post order** — connect a wallet, enter an amount, set the floor (from the quote ×
  slippage) + an optional tip/partial flag → the app builds the `OrderDatum` UTXO at
  the `S`-tagged order address, the wallet signs and submits. Non-custodial.
- **Reclaim order** — owner-signed spend of your own order via the on-chain order
  reference script (`/orders` → Reclaim).
- Quote/price-impact/floor on the swap card use the real pool reserves.

**Stubbed / out of scope here (by design):**
- **Settlement / batch clearing** — the untrusted solver's job (`batcher/`), not the
  app's.
- The on-screen quote is a constant-product **estimate**, not the protocol's
  uniform-price clearing — you post an intent; the solver settles it later, never
  below your floor.
- Token metadata/icons (tickers are decoded from the asset name; decimals default to
  0 for non-ADA), order history/"settled" status (only live orders are listed), and
  LP deposit/withdraw.
