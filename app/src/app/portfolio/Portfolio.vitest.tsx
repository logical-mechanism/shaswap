/**
 * Component test for the Portfolio summary page: the disconnected invite, and the three
 * summary cards (resting orders / liquidity / wallet) with their counts + honest summaries
 * for both a populated and an empty wallet. The data hooks are mocked; the live→row merge,
 * the counts, and the token summary run for real. Run with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { WalletPosition, LpIntentPosition, TokenInfo } from "@/lib/data";

const ADA: TokenInfo = { unit: "lovelace", ticker: "ADA", name: "Cardano", decimals: 6 };
const TEST: TokenInfo = { unit: "u_test", ticker: "TEST", name: "Test", decimals: 0 };

const order = (ref: string): WalletPosition => ({
  ref,
  tokenIn: TEST,
  tokenOut: ADA,
  amountIn: "100",
  minOut: "50",
  status: "open",
  partial: false,
  deadline: null,
});

const intent = (ref: string): LpIntentPosition => ({
  ref,
  poolNft: "pool0",
  action: "deposit",
  tokenA: ADA,
  tokenB: TEST,
  depositA: "1000000",
  depositB: "100",
  minA: "0",
  minB: "0",
  minShares: "0",
  tip: "1000000",
  deadline: null,
});

const h = vi.hoisted(() => ({
  connected: true,
  ownerAddr: "addr_owner" as string | undefined,
  ownerError: false,
  lovelace: "1500000000" as string | undefined,
  assets: [] as { unit: string; quantity: string }[],
  orders: [] as WalletPosition[],
  intents: [] as LpIntentPosition[],
  // Set in beforeEach — `vi.hoisted` runs before the ADA/TEST consts are initialised.
  tokens: [] as TokenInfo[],
  tokensLoading: false,
  refresh: vi.fn(),
}));

vi.mock("@/lib/wallet/hooks", () => ({
  useWallet: () => ({ connected: h.connected, refresh: h.refresh }),
  useLovelace: () => h.lovelace,
  useAssets: () => h.assets,
}));
vi.mock("@/hooks/useOwnerAddress", () => ({
  useOwnerAddress: () => ({ ownerAddr: h.ownerAddr, ownerError: h.ownerError }),
}));
vi.mock("@/hooks/useOrders", () => ({
  useOrders: () => ({ orders: h.orders, loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/hooks/useLpIntents", () => ({
  useLpIntents: () => ({ intents: h.intents, loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/hooks/useTokens", () => ({
  useTokens: () => ({ tokens: h.tokens, loading: h.tokensLoading, error: null }),
}));

import PortfolioPage from "./page";

/** The card whose heading is `title` — scope assertions to it so counts can't cross-match. */
function card(title: string) {
  return screen.getByRole("heading", { name: title }).closest("a") as HTMLElement;
}

beforeEach(() => {
  h.connected = true;
  h.ownerAddr = "addr_owner";
  h.ownerError = false;
  h.lovelace = "1500000000";
  h.assets = [];
  h.orders = [];
  h.intents = [];
  h.tokens = [ADA, TEST];
  h.tokensLoading = false;
  h.refresh.mockClear();
  window.localStorage.clear();
});

describe("PortfolioPage", () => {
  it("invites a connect when no wallet is connected (no cards)", () => {
    h.connected = false;
    h.ownerAddr = undefined;
    render(<PortfolioPage />);
    expect(screen.getByText(/Connect a wallet/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Resting orders" })).toBeNull();
  });

  it("shows resting-order, liquidity, and wallet counts for a populated wallet", () => {
    h.orders = [order("a#0"), order("b#0")];
    h.intents = [intent("c#0")];
    h.assets = [{ unit: "u_test", quantity: "5" }];
    render(<PortfolioPage />);

    const orders = card("Resting orders");
    expect(within(orders).getByText("2")).toBeInTheDocument();
    expect(within(orders).getByText(/resting in the next batch/i)).toBeInTheDocument();

    const liq = card("Liquidity moves");
    expect(within(liq).getByText("1")).toBeInTheDocument();
    expect(within(liq).getByText(/waiting in the gardens/i)).toBeInTheDocument();

    const wallet = card("Wallet");
    expect(within(wallet).getByText("₳1,500")).toBeInTheDocument();
    expect(within(wallet).getByText(/\+ 1 token: TEST/)).toBeInTheDocument();

    // Cards link into their detail pages.
    expect(orders).toHaveAttribute("href", "/orders");
    expect(liq).toHaveAttribute("href", "/pools");
    expect(wallet).toHaveAttribute("href", "/");
  });

  it("shows honest zero states for an empty wallet", () => {
    h.orders = [];
    h.intents = [];
    h.assets = [];
    h.lovelace = "0";
    render(<PortfolioPage />);

    expect(within(card("Resting orders")).getByText(/Nothing resting right now/i)).toBeInTheDocument();
    expect(
      within(card("Liquidity moves")).getByText(/No deposits or withdrawals in flight/i),
    ).toBeInTheDocument();
    const wallet = card("Wallet");
    expect(within(wallet).getByText("₳0")).toBeInTheDocument();
    expect(within(wallet).getByText(/Nothing else in here for now/i)).toBeInTheDocument();
  });

  it("owns up to unrecognised holdings instead of claiming ADA-only", () => {
    // The wallet holds an asset the registry can't name (e.g. an NFT) — the card must NOT
    // claim "just ADA"; it acknowledges the unrecognised holding honestly.
    h.assets = [{ unit: "policy.nft", quantity: "1" }];
    h.tokens = [ADA];
    render(<PortfolioPage />);
    const wallet = card("Wallet");
    expect(within(wallet).getByText(/Plus 1 thing Pip doesn’t recognise/i)).toBeInTheDocument();
    expect(within(wallet).queryByText(/Nothing else in here/i)).toBeNull();
  });
});
