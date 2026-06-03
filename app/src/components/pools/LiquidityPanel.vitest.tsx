/**
 * Component tests for LiquidityPanel — the add/remove preview math wiring (it drives the
 * REAL pure builders in lib/chain/lp), the max-burnable cap at `circ − MIN_LIQ`, and the
 * sr-only aria-live preview announcements. The wallet + write-gate + pool-UTXO hooks and
 * the tx builders are mocked; the share math runs for real against a fixture pool. Run with
 * `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { POOL, POOL_LP_UNIT, poolViewWithCirc } from "../../test/fixtures";
import { poolStats } from "@/lib/chain/lp";
import { MIN_LIQ } from "@/lib/chain/deployment";

// A seeded pool: circ = 1,000,000 LP, reserves 1000 ADA / 2,000,000,000 TEST.
const VIEW = poolViewWithCirc(1_000_000n);
const STATS = poolStats(VIEW);

const h = vi.hoisted(() => {
  const state = {
    connected: true,
    address: "addr_test1_owner",
    assets: [] as { unit: string; quantity: string }[],
  };
  const wallet = {
    getChangeAddress: () => Promise.resolve(state.address),
    getAssets: () => Promise.resolve(state.assets),
  };
  return {
    state,
    wallet,
    deposit: vi.fn(),
    withdraw: vi.fn(),
    close: vi.fn(),
  };
});

// NB: @meshsdk/core is NOT mocked — it loads fine in jsdom (datums.ts already pulls it in)
// and LiquidityPanel only calls `deserializeAddress` on the change address, which throws on
// our placeholder address and is caught (walletPkh stays null; isCreator is not under test).
vi.mock("@meshsdk/react", () => ({
  useAddress: () => h.state.address,
  useWallet: () => ({ connected: h.state.connected, wallet: h.wallet }),
}));
vi.mock("@/hooks/usePoolUtxo", () => ({
  usePoolUtxo: () => ({
    view: VIEW,
    stats: STATS,
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock("@/hooks/useWriteGate", () => ({
  useWriteGate: () => ({
    networkReady: true,
    wrongNetwork: false,
    collateralReady: true,
    needsCollateral: false,
    recheckCollateral: () => {},
  }),
}));
vi.mock("@/lib/client/tx", () => ({
  depositLiquidity: (...a: unknown[]) => h.deposit(...a),
  withdrawLiquidity: (...a: unknown[]) => h.withdraw(...a),
  closePool: (...a: unknown[]) => h.close(...a),
}));

import { LiquidityPanel } from "./LiquidityPanel";

beforeEach(() => {
  h.state.connected = true;
  h.state.address = "addr_test1_owner";
  h.state.assets = [];
});

/** The single editable amount input on the active form. */
function editableInput(): HTMLInputElement {
  const el = (screen.getAllByRole("textbox") as HTMLInputElement[]).find(
    (i) => !i.readOnly,
  );
  if (!el) throw new Error("no editable input");
  return el;
}

describe("LiquidityPanel — add", () => {
  it("wires the deposit preview math (LP received + min after slippage)", () => {
    render(<LiquidityPanel pool={POOL} />);
    // amountA = ADA side (decimals 6). 100 ADA at the 1000/2e9 ratio → 100,000 LP.
    fireEvent.change(editableInput(), { target: { value: "100" } });

    const lp = (100_000).toLocaleString();
    const minLp = (99_500).toLocaleString(); // 100,000 × (1 − 0.5%)
    expect(screen.getByText(`≈ ${lp} LP`)).toBeInTheDocument();
    expect(screen.getByText(`${minLp} LP`)).toBeInTheDocument();
    // sr-only aria-live mirror
    expect(
      screen.getByText(`LP you receive ≈ ${lp}; at least ${minLp} LP after slippage.`),
    ).toBeInTheDocument();
  });
});

describe("LiquidityPanel — remove", () => {
  function gotoRemove() {
    render(<LiquidityPanel pool={POOL} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  }

  it("Max burns the wallet's LP when below the cap, and previews the payout", async () => {
    h.state.assets = [{ unit: POOL_LP_UNIT, quantity: "500000" }]; // < circ − min_liq
    gotoRemove();
    // lpBalance loads async; the Max button reflects it.
    const maxBtn = await screen.findByRole("button", { name: "Max 500,000" });
    fireEvent.click(maxBtn);
    expect(editableInput().value).toBe("500000");
    // 500,000 LP of 1,000,000 circ → half the reserves: 500 ADA + 1e9 TEST.
    expect(
      screen.getByText(
        /You receive ≈ 500 ADA plus 1,000,000,000 TEST; at least 497\.5 ADA and 995,000,000 TEST after slippage\./,
      ),
    ).toBeInTheDocument();
  });

  it("caps Max at circ − MIN_LIQ when the wallet holds more LP than that", async () => {
    // wallet holds far more LP than circ − min_liq; the burn must be capped.
    h.state.assets = [{ unit: POOL_LP_UNIT, quantity: "5000000" }];
    gotoRemove();
    const cap = (STATS.circ - MIN_LIQ).toLocaleString(); // 999,000
    const maxBtn = await screen.findByRole("button", { name: `Max ${cap}` });
    fireEvent.click(maxBtn);
    expect(editableInput().value).toBe((STATS.circ - MIN_LIQ).toString());
  });
});
