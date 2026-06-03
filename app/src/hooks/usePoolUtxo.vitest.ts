/**
 * Hook tests for usePoolUtxo — resolving the live pool UTXO for the LP previews. With no
 * interval poll, the key behaviour is that a transient reload failure must NOT wipe a
 * usable panel (a first-load failure still surfaces the error). The /api seam is mocked at
 * `fetchPoolUtxo`. Run with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { encodePoolDatum, toCbor } from "@/lib/chain/datums";
import { POOL_DATUM, POOL_NFT_UNIT, poolViewWithCirc } from "../test/fixtures";

const h = vi.hoisted(() => ({ fetchPoolUtxo: vi.fn() }));
vi.mock("@/lib/client/api", () => ({
  fetchPoolUtxo: (...a: unknown[]) => h.fetchPoolUtxo(...a),
}));

import { usePoolUtxo } from "./usePoolUtxo";

const DATUM_CBOR = toCbor(encodePoolDatum(POOL_DATUM));

/** A resolved pool UTXO carrying the inline PoolDatum + the value for `circ` LP. */
function poolUtxo(circ: bigint) {
  const view = poolViewWithCirc(circ);
  return {
    input: { txHash: "ab".repeat(32), outputIndex: 0 },
    output: {
      address: "addr_test1_pool",
      amount: view.value,
      plutusData: DATUM_CBOR,
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.fetchPoolUtxo = vi.fn();
});

describe("usePoolUtxo", () => {
  it("loads the pool view + derived stats", async () => {
    h.fetchPoolUtxo.mockResolvedValue(poolUtxo(1_000_000n));
    const { result } = renderHook(() => usePoolUtxo(POOL_NFT_UNIT));
    await waitFor(() => expect(result.current.stats).not.toBeNull());
    expect(result.current.stats?.circ).toBe(1_000_000n);
    expect(result.current.view).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("a first-load failure surfaces the error and leaves no view", async () => {
    h.fetchPoolUtxo.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePoolUtxo(POOL_NFT_UNIT));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.view).toBeNull();
    expect(result.current.stats).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it("a transient reload failure KEEPS the last-good view (no poll to recover it)", async () => {
    h.fetchPoolUtxo.mockResolvedValue(poolUtxo(1_000_000n));
    const { result } = renderHook(() => usePoolUtxo(POOL_NFT_UNIT));
    await waitFor(() => expect(result.current.stats).not.toBeNull());

    // A manual ↻ that hits a transient blip must not collapse the panel.
    h.fetchPoolUtxo.mockRejectedValue(new Error("blip"));
    act(() => result.current.reload());
    await waitFor(() => expect(h.fetchPoolUtxo).toHaveBeenCalledTimes(2));
    await flush();

    expect(result.current.stats?.circ).toBe(1_000_000n); // retained
    expect(result.current.view).not.toBeNull();
    expect(result.current.error).toBeNull(); // no error surfaced over usable data
  });
});
