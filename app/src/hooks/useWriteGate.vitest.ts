/**
 * Hook tests for useWriteGate — the shared connect → wrong-network → network-ready →
 * collateral gating ladder every script-spend flow reuses. Pins the boolean derivations
 * and the `baseReason` label ladder, incl. the fail-closed behaviour (network "ready" only
 * once the id is KNOWN and equal; collateral "ready" while the check is still in flight).
 * Run with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { APP_CONFIG } from "@/lib/config";

const h = vi.hoisted(() => ({
  connected: false,
  networkId: undefined as number | undefined,
  collateral: { hasCollateral: false, loading: true, recheck: vi.fn() },
}));

vi.mock("@meshsdk/react", () => ({
  useWallet: () => ({ connected: h.connected }),
  useNetwork: () => h.networkId,
}));
vi.mock("./useWalletCollateral", () => ({
  useWalletCollateral: () => h.collateral,
}));

import { useWriteGate } from "./useWriteGate";

const OK = APP_CONFIG.networkId; // 0 on the preprod default
const WRONG = OK === 0 ? 1 : 0;

beforeEach(() => {
  h.connected = false;
  h.networkId = undefined;
  h.collateral = { hasCollateral: false, loading: true, recheck: vi.fn() };
});

describe("useWriteGate — baseReason ladder + derivations", () => {
  it("disconnected → Connect wallet", () => {
    const { result } = renderHook(() => useWriteGate());
    expect(result.current.connected).toBe(false);
    expect(result.current.networkReady).toBe(false);
    expect(result.current.wrongNetwork).toBe(false);
    expect(result.current.baseReason).toBe("Connect wallet");
  });

  it("connected on the wrong network → Wrong network", () => {
    h.connected = true;
    h.networkId = WRONG;
    const { result } = renderHook(() => useWriteGate());
    expect(result.current.wrongNetwork).toBe(true);
    expect(result.current.networkReady).toBe(false);
    expect(result.current.baseReason).toBe("Wrong network");
  });

  it("connected but network id not yet known → Checking network… (fail-closed)", () => {
    h.connected = true;
    h.networkId = undefined;
    const { result } = renderHook(() => useWriteGate());
    expect(result.current.wrongNetwork).toBe(false); // undefined is NOT "wrong"
    expect(result.current.networkReady).toBe(false); // ...but it is NOT ready either
    expect(result.current.baseReason).toBe("Checking network…");
  });

  it("right network, collateral not required → no blocker", () => {
    h.connected = true;
    h.networkId = OK;
    const { result } = renderHook(() => useWriteGate({ requireCollateral: false }));
    expect(result.current.networkReady).toBe(true);
    expect(result.current.baseReason).toBeNull();
  });

  it("collateral required + absent (check done) → Set a collateral UTXO", () => {
    h.connected = true;
    h.networkId = OK;
    h.collateral = { hasCollateral: false, loading: false, recheck: vi.fn() };
    const { result } = renderHook(() => useWriteGate({ requireCollateral: true }));
    expect(result.current.needsCollateral).toBe(true);
    expect(result.current.collateralReady).toBe(false);
    expect(result.current.baseReason).toBe("Set a collateral UTXO");
  });

  it("collateral required but check still in flight → ready (not blocked prematurely)", () => {
    h.connected = true;
    h.networkId = OK;
    h.collateral = { hasCollateral: false, loading: true, recheck: vi.fn() };
    const { result } = renderHook(() => useWriteGate({ requireCollateral: true }));
    expect(result.current.collateralReady).toBe(true); // loading counts as ready
    expect(result.current.needsCollateral).toBe(false);
    expect(result.current.baseReason).toBeNull();
  });

  it("collateral required + present → no blocker", () => {
    h.connected = true;
    h.networkId = OK;
    h.collateral = { hasCollateral: true, loading: false, recheck: vi.fn() };
    const { result } = renderHook(() => useWriteGate({ requireCollateral: true }));
    expect(result.current.collateralReady).toBe(true);
    expect(result.current.needsCollateral).toBe(false);
    expect(result.current.baseReason).toBeNull();
  });
});
