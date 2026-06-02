import type { Action, Protocol, UTxO } from "@meshsdk/core";
import type { DataProvider } from "./provider";
import type { Pool, Quote, TokenInfo, WalletPosition } from "./types";

/**
 * MockProvider — static/fake data so the skeleton renders end-to-end without
 * any real chain access. It implements the SAME `DataProvider` interface a real
 * provider will, so swapping it out later is a one-line change in ./index.ts.
 *
 * The quote math here is a toy constant-product (x*y=k) curve. It exists ONLY
 * to produce a plausible number in the UI — it is explicitly NOT ShaSwap's
 * batch-auction clearing, and nothing here is settled or submitted.
 */

const ADA: TokenInfo = {
  unit: "lovelace",
  ticker: "ADA",
  name: "Cardano",
  decimals: 6,
};

// Mirrors the preprod test token from the deployed contracts (illustrative).
const TEST: TokenInfo = {
  unit: "8160c878…54455354",
  ticker: "TEST",
  name: "ShaSwap Test Token",
  decimals: 0,
};

const HOSKY: TokenInfo = {
  unit: "mock0001…484f534b59",
  ticker: "HOSKY",
  name: "Hosky (mock)",
  decimals: 0,
};

const TOKENS: TokenInfo[] = [ADA, TEST, HOSKY];
const BY_UNIT = new Map(TOKENS.map((t) => [t.unit, t]));

const POOLS: Pool[] = [
  {
    id: "1c3be7b9…poolnft",
    tokenA: ADA,
    tokenB: TEST,
    reserveA: "861338911", // ~861 ADA
    reserveB: "1200000000",
    feeBps: 30,
  },
  {
    id: "a2c6916e…poolnft",
    tokenA: ADA,
    tokenB: HOSKY,
    reserveA: "300000000",
    reserveB: "500000000",
    feeBps: 30,
  },
];

const POSITIONS: WalletPosition[] = [
  {
    ref: "fb4bacae…#0",
    tokenIn: TEST,
    tokenOut: ADA,
    amountIn: "100000000",
    minOut: "50000000",
    status: "open",
  },
  {
    ref: "05d99063…#0",
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn: "20000000",
    minOut: "40000000",
    status: "settled",
  },
];

/** Find the pool that trades exactly {inUnit, outUnit} in either direction. */
function findPool(inUnit: string, outUnit: string): Pool | undefined {
  return POOLS.find(
    (p) =>
      (p.tokenA.unit === inUnit && p.tokenB.unit === outUnit) ||
      (p.tokenA.unit === outUnit && p.tokenB.unit === inUnit),
  );
}

export class MockProvider implements DataProvider {
  readonly name = "mock";

  async listTokens(): Promise<TokenInfo[]> {
    return TOKENS;
  }

  async listPools(): Promise<Pool[]> {
    return POOLS;
  }

  async getPool(poolId: string): Promise<Pool | null> {
    return POOLS.find((p) => p.id === poolId) ?? null;
  }

  async priceQuote(
    tokenInUnit: string,
    tokenOutUnit: string,
    amountIn: string,
  ): Promise<Quote | null> {
    const tokenIn = BY_UNIT.get(tokenInUnit);
    const tokenOut = BY_UNIT.get(tokenOutUnit);
    if (!tokenIn || !tokenOut) return null;

    const pool = findPool(tokenInUnit, tokenOutUnit);
    if (!pool) return null;

    const amtIn = toBig(amountIn);
    // Orient reserves to the direction of the swap.
    const inIsA = pool.tokenA.unit === tokenInUnit;
    const reserveIn = toBig(inIsA ? pool.reserveA : pool.reserveB);
    const reserveOut = toBig(inIsA ? pool.reserveB : pool.reserveA);

    if (amtIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
      return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: "0",
        price: "0",
        priceImpact: 0,
        poolId: pool.id,
      };
    }

    // Toy constant-product with fee (display only — NOT the protocol clearing).
    const feeBps = BigInt(pool.feeBps);
    const inAfterFee = (amtIn * (10_000n - feeBps)) / 10_000n;
    const amountOut = (reserveOut * inAfterFee) / (reserveIn + inAfterFee);

    // Mid price (out per in) and price impact vs the spot mid.
    const SCALE = 1_000_000n;
    const midScaled = (reserveOut * SCALE) / reserveIn;
    const execScaled = amtIn > 0n ? (amountOut * SCALE) / amtIn : 0n;
    const priceImpact =
      midScaled > 0n
        ? Math.max(0, Number(midScaled - execScaled) / Number(midScaled))
        : 0;

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amountOut.toString(),
      price: (Number(midScaled) / Number(SCALE)).toString(),
      priceImpact,
      poolId: pool.id,
    };
  }

  async walletPositions(address: string): Promise<WalletPosition[]> {
    // Skeleton: return the same illustrative set regardless of address.
    void address;
    return POSITIONS;
  }

  // The mock has no chain access, so it cannot supply protocol params or evaluate a
  // tx. These only matter on the order build/reclaim paths, which require a real
  // provider; fail loudly rather than hand back fake values.
  async protocolParameters(): Promise<Protocol> {
    throw new Error("MockProvider cannot supply protocol parameters");
  }

  async evaluateTx(): Promise<Omit<Action, "data">[]> {
    throw new Error("MockProvider cannot evaluate transactions");
  }

  async resolveUtxo(): Promise<UTxO | null> {
    throw new Error("MockProvider cannot resolve UTXOs");
  }
}

function toBig(s: string): bigint {
  try {
    return BigInt(s.split(".")[0] || "0");
  } catch {
    return 0n;
  }
}
