# ShaSwap — Web App (`app/`)

The website / dApp for **ShaSwap**, a non-custodial, MEV-resistant batch-auction
DEX on Cardano (eUTXO). See the repo root [`CLAUDE.md`](../CLAUDE.md) and the
authoritative design in [`documentation/BLUEPRINT.md`](../documentation/BLUEPRINT.md).

> **Status: skeleton.** This is the structural shell — a swap-card UI, wallet
> connect, the nav, and the data-access seam — wired end-to-end against **mock
> data**. There is **no** settlement/clearing/order-building or real provider
> access yet; those land on later branches.

## Stack

- **Next.js 16** (App Router) + **TypeScript** (strict) + **Tailwind CSS v4**
- **MeshJS** — `@meshsdk/react` (`MeshProvider`, `useWallet`, `CardanoWallet`,
  `useAddress`, `useLovelace`, `useNetwork`) + `@meshsdk/core`
- Bundler: **Turbopack** (Next 16 default; resolves MeshJS's WASM libs natively)

## Run

```bash
cd app
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm run lint     # eslint (must be clean)
```

Node ≥ 20.19 / 22.13 recommended (MeshJS + Next 16).

## Network

The app is **network-aware from a single config value** —
[`src/lib/config.ts`](src/lib/config.ts) `APP_CONFIG.network`, default **preprod**
(matching the deployed contracts). Override with the `NEXT_PUBLIC_NETWORK` env
var. The CIP-30 `networkId` is derived from it, and the header flags a wallet
whose network doesn't match.

## The data-access rule (INVIOLABLE — see CLAUDE.md)

**All chain data goes through ONE swappable abstraction. No component, hook, or
route handler calls a specific provider (Koios / Blockfrost / Maestro / Kupo /
Ogmios / our own Dolos node) directly.**

How it's wired here:

```
 React components ─▶ hooks (src/hooks/*) ─▶ client fetchers (src/lib/client/api.ts)
                                                   │  fetch() our OWN /api/*
                                                   ▼
        Next route handlers (src/app/api/*/route.ts)  ◀── server-side only
                                                   │
                                                   ▼
        getDataProvider()  (src/lib/data/index.ts)  ◀── THE single swap point
                                                   │
                                                   ▼
                          DataProvider impl (MockProvider today)
```

- **The interface:** [`src/lib/data/provider.ts`](src/lib/data/provider.ts)
  (`DataProvider`) with domain types in
  [`src/lib/data/types.ts`](src/lib/data/types.ts) (`TokenInfo`, `Pool`, `Quote`,
  `OrderIntent`, `WalletPosition`).
- **The mock:** [`src/lib/data/mock.ts`](src/lib/data/mock.ts) returns static
  data + a toy constant-product quote so the UI renders. **This is not the
  protocol's clearing math** and builds nothing on-chain.
- **The server is the data layer.** Provider calls happen in Next **route
  handlers** (`src/app/api/{tokens,pools,quote,orders}/route.ts`) so any future
  provider keys stay server-side; the client only ever fetches `/api/*`.

### Swapping in a real provider (or our own node)

It's a **one-file change**: implement `DataProvider` in a new file under
`src/lib/data/` and return it from `getDataProvider()` in
[`src/lib/data/index.ts`](src/lib/data/index.ts) (keyed off an env var — see the
commented `switch` there). No route handler, hook, or component changes, because
they all go through that one function.

## Layout

```
src/
  app/
    layout.tsx              root: MeshProvider + Nav + Footer, dark theme
    page.tsx                / — the swap card
    pools/page.tsx          /pools — stub list (mock, via the seam)
    orders/page.tsx         /orders — stub list (mock, via the seam)
    api/
      tokens/route.ts       GET  → provider.listTokens()
      pools/route.ts        GET  → provider.listPools()
      quote/route.ts        GET  → provider.priceQuote(in,out,amount)
      orders/route.ts       GET  → provider.walletPositions(address)
  components/
    Providers.tsx           "use client" MeshProvider wrapper
    Nav.tsx, Logo.tsx, Footer.tsx, WalletBar.tsx
    swap/SwapCard.tsx       the core swap card
    swap/TokenSelect.tsx, swap/SlippageSettings.tsx
  hooks/
    useTokens / usePools / useQuote / useOrders   (call /api/* only)
  lib/
    config.ts               network config (single source)
    format.ts               display formatters
    client/api.ts           client → /api/* fetchers
    data/                    the data-access abstraction (the seam)
```

## Skeleton scope

**Built:** wallet connect (no login — connect & go), header with address + ADA
balance + network chip, a swap card (from/to selectors, direction toggle, mock
rate / price-impact line, visual-only slippage settings, a state-aware primary
button: *Connect wallet → Enter an amount → Swap (coming soon)*, always
disabled), `/pools` and `/orders` stubs reading mock data through the seam, and
loading/empty states.

**Deferred (later branches):** real order intents, batch-auction settlement /
clearing, transaction building & submission, a real `DataProvider` (hosted
provider or our own Dolos node), token metadata/icons, and slippage actually
affecting anything.
