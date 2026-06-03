/**
 * Hook tests for useQuote — the debounced quote fetch behind /api/quote. Pins: it stays
 * idle (no request) without a usable amount; it debounces a burst of input changes into a
 * SINGLE request for the final value; and `reload()` re-issues the request on demand. The
 * /api seam is mocked at `fetchQuote`. Run with `npm run test:components`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Quote } from "@/lib/data";
import { ADA, TEST } from "../test/fixtures";

const h = vi.hoisted(() => ({ fetchQuote: vi.fn() }));
vi.mock("@/lib/client/api", () => ({
  fetchQuote: (...a: unknown[]) => h.fetchQuote(...a),
}));

import { useQuote } from "./useQuote";

function quote(amountIn: string): Quote {
  return {
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn,
    amountOut: "1900000000",
    price: "1.9",
    priceImpact: 0.01,
    poolId: "pool",
  };
}

beforeEach(() => {
  h.fetchQuote = vi.fn((_in: string, _out: string, amount: string) =>
    Promise.resolve(quote(amount)),
  );
});

describe("useQuote", () => {
  it("stays idle with no amount (no request, null quote)", async () => {
    const { result } = renderHook(() => useQuote(ADA.unit, TEST.unit, ""));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quote).toBeNull();
    expect(h.fetchQuote).not.toHaveBeenCalled();
  });

  it("stays idle when in/out are the same token", async () => {
    const { result } = renderHook(() => useQuote(ADA.unit, ADA.unit, "1000000"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.fetchQuote).not.toHaveBeenCalled();
  });

  it("fetches a quote for a valid amount", async () => {
    const { result } = renderHook(() => useQuote(ADA.unit, TEST.unit, "1000000"));
    await waitFor(() => expect(result.current.quote).not.toBeNull());
    expect(h.fetchQuote).toHaveBeenCalledTimes(1);
    expect(h.fetchQuote).toHaveBeenLastCalledWith(
      ADA.unit,
      TEST.unit,
      "1000000",
      expect.anything(), // the AbortSignal
    );
  });

  it("debounces a burst of amount changes into ONE request for the final value", async () => {
    const { rerender, result } = renderHook(
      ({ amount }) => useQuote(ADA.unit, TEST.unit, amount),
      { initialProps: { amount: "100" } },
    );
    // Rapid changes before the 250ms debounce elapses — each resets the timer.
    rerender({ amount: "200" });
    rerender({ amount: "300" });
    await waitFor(() => expect(result.current.quote).not.toBeNull());
    expect(h.fetchQuote).toHaveBeenCalledTimes(1);
    expect(h.fetchQuote).toHaveBeenLastCalledWith(
      ADA.unit,
      TEST.unit,
      "300",
      expect.anything(),
    );
  });

  it("clears a prior error optimistically when inputs change", async () => {
    h.fetchQuote = vi.fn().mockRejectedValueOnce("boom"); // first quote fails
    const { rerender, result } = renderHook(
      ({ amount }) => useQuote(ADA.unit, TEST.unit, amount),
      { initialProps: { amount: "100" } },
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // The next fetch hangs, isolating the optimistic clear: changing the amount must
    // drop the stale error immediately rather than wait for the (pending) refetch.
    h.fetchQuote.mockReturnValue(new Promise(() => {}));
    rerender({ amount: "200" });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("reload() re-issues the request", async () => {
    const { result } = renderHook(() => useQuote(ADA.unit, TEST.unit, "1000000"));
    await waitFor(() => expect(result.current.quote).not.toBeNull());
    expect(h.fetchQuote).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await waitFor(() => expect(h.fetchQuote).toHaveBeenCalledTimes(2));
  });
});
