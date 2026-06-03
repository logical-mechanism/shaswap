/**
 * Hook tests for useWalletCollateral — the proactive CIP-30 `getCollateral()` probe that
 * the script-spend flows gate on. Covers the resolve/empty/throw cases, the `recheck()`
 * re-query, and the focus/visibility auto-recheck while collateral is still missing. Run
 * with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// The wallet object must be a STABLE reference (the hook's effect deps on `wallet`); a
// fresh object per render would re-fire the query every render. So return one wallet that
// delegates to the current spy.
const h = vi.hoisted(() => {
  const state = { connected: false, getCollateral: vi.fn() };
  const wallet = { getCollateral: (...a: unknown[]) => state.getCollateral(...a) };
  return { state, wallet };
});

vi.mock("@meshsdk/react", () => ({
  useWallet: () => ({ connected: h.state.connected, wallet: h.wallet }),
}));

import { useWalletCollateral } from "./useWalletCollateral";

beforeEach(() => {
  h.state.connected = false;
  h.state.getCollateral = vi.fn();
  // jsdom defaults vary; force a visible tab so the focus/visibility recheck path runs.
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

describe("useWalletCollateral", () => {
  it("disconnected → resolves to no collateral, not loading", async () => {
    const { result } = renderHook(() => useWalletCollateral());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasCollateral).toBe(false);
    expect(h.state.getCollateral).not.toHaveBeenCalled();
  });

  it("connected with a collateral UTXO → hasCollateral true", async () => {
    h.state.connected = true;
    h.state.getCollateral.mockResolvedValue([{ input: {}, output: {} }]);
    const { result } = renderHook(() => useWalletCollateral());
    await waitFor(() => expect(result.current.hasCollateral).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  it("connected with no collateral set → hasCollateral false", async () => {
    h.state.connected = true;
    h.state.getCollateral.mockResolvedValue([]);
    const { result } = renderHook(() => useWalletCollateral());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasCollateral).toBe(false);
  });

  it("a wallet that throws on getCollateral is treated as absent (never crashes)", async () => {
    h.state.connected = true;
    h.state.getCollateral.mockRejectedValue(new Error("no collateral set"));
    const { result } = renderHook(() => useWalletCollateral());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasCollateral).toBe(false);
  });

  it("recheck() re-queries the wallet (recovers once collateral is set)", async () => {
    h.state.connected = true;
    h.state.getCollateral.mockResolvedValue([]); // initially none
    const { result } = renderHook(() => useWalletCollateral());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasCollateral).toBe(false);

    h.state.getCollateral.mockResolvedValue([{ input: {}, output: {} }]); // now set
    act(() => result.current.recheck());
    await waitFor(() => expect(result.current.hasCollateral).toBe(true));
    expect(h.state.getCollateral).toHaveBeenCalledTimes(2);
  });

  it("auto-rechecks on window focus while collateral is still missing", async () => {
    h.state.connected = true;
    h.state.getCollateral.mockResolvedValue([]);
    const { result } = renderHook(() => useWalletCollateral());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.state.getCollateral).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(h.state.getCollateral).toHaveBeenCalledTimes(2));
  });
});
