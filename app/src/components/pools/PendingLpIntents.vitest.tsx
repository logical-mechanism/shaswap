/**
 * Component test for the per-pool LP-intent surface: a live withdraw intent renders with the
 * §13 honesty copy (reclaim returns LP, not underlying) and a Reclaim button that calls
 * `reclaimLpIntent`. The wallet / write-gate / lp-intents hooks and the tx builder are mocked;
 * the live→row merge runs for real. Run with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { POOL } from "../../test/fixtures";
import type { LpIntentPosition } from "@/lib/data";

const WITHDRAW_INTENT: LpIntentPosition = {
  ref: "abc123#0",
  poolNft: POOL.id,
  action: "withdraw",
  tokenA: POOL.tokenA,
  tokenB: POOL.tokenB,
  lp: "250000",
  minA: "100000000",
  minB: "140000000",
  minShares: "0",
  tip: "1000000",
  deadline: null,
};

const h = vi.hoisted(() => ({
  intents: [] as LpIntentPosition[],
  reclaim: vi.fn(async () => "reclaimtxhash"),
}));

vi.mock("@meshsdk/react", () => ({
  useWallet: () => ({
    connected: true,
    wallet: { getChangeAddress: () => Promise.resolve("addr_test1_owner") },
  }),
}));
vi.mock("@/hooks/useWriteGate", () => ({
  useWriteGate: () => ({
    networkReady: true,
    wrongNetwork: false,
    collateralReady: true,
    needsCollateral: false,
    recheckCollateral: () => {},
    baseReason: null,
  }),
}));
vi.mock("@/hooks/useLpIntents", () => ({
  useLpIntents: () => ({ intents: h.intents, loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/lib/client/api", () => ({ fetchTxConfirmed: () => Promise.resolve(true) }));
vi.mock("@/lib/client/tx", () => ({ reclaimLpIntent: (...a: unknown[]) => h.reclaim(...a) }));

import { PendingLpIntents } from "./PendingLpIntents";

beforeEach(() => {
  h.intents = [WITHDRAW_INTENT];
  h.reclaim.mockClear();
  window.localStorage.clear();
});

describe("PendingLpIntents", () => {
  it("renders a live withdraw intent with the §13 honesty copy + a Reclaim button", async () => {
    render(<PendingLpIntents pool={POOL} refreshKey={0} />);

    expect(await screen.findByText(/Withdraw 250,000 LP/)).toBeInTheDocument();
    // UX honesty: a withdraw reclaim returns LP tokens, not the underlying.
    expect(
      screen.getByText(/returns your LP tokens \(not the underlying\)/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reclaim" })).toBeEnabled();
  });

  it("Reclaim spends the intent via reclaimLpIntent(ref)", async () => {
    render(<PendingLpIntents pool={POOL} refreshKey={0} />);
    const btn = await screen.findByRole("button", { name: "Reclaim" });
    fireEvent.click(btn);
    await waitFor(() => expect(h.reclaim).toHaveBeenCalledTimes(1));
    expect(h.reclaim.mock.calls[0][1]).toBe("abc123#0");
  });

  it("renders nothing when there are no intents for this pool", async () => {
    h.intents = [];
    const { container } = render(<PendingLpIntents pool={POOL} refreshKey={0} />);
    // Give the async owner-resolution a tick; the surface returns null with no rows.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
