import type { Action, Protocol, UTxO } from "@meshsdk/core";
import type { DataProvider } from "./provider";
import { planRoute } from "./route";
import type {
  LpIntentPosition,
  Pool,
  ReferencePrice,
  Route,
  TokenInfo,
  WalletPosition,
} from "./types";

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
    firstDeposit: false,
  },
  {
    id: "a2c6916e…poolnft",
    tokenA: ADA,
    tokenB: HOSKY,
    reserveA: "300000000",
    reserveB: "500000000",
    feeBps: 30,
    firstDeposit: false,
  },
  {
    // An empty (never-seeded) pool, so the "needs first deposit" affordance is exercised.
    id: "e0000000…poolnft",
    tokenA: TEST,
    tokenB: HOSKY,
    reserveA: "0",
    reserveB: "0",
    feeBps: 30,
    firstDeposit: true,
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
    partial: false,
    // ~6h out, so the resting-order "snug until …" caption is visible in the offline mock.
    deadline: (Date.now() + 6 * 60 * 60 * 1000).toString(),
  },
  {
    ref: "05d99063…#0",
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn: "20000000",
    minOut: "40000000",
    status: "settled",
    partial: false,
    deadline: null,
  },
];

// Illustrative LP intents (a pending withdraw + a pending deposit) on the ADA/TEST pool, so
// the LP-intent surface renders in the offline mock. Nothing here is on-chain or fulfillable.
const LP_INTENTS: LpIntentPosition[] = [
  {
    ref: "aabbccddeeff00112233445566778899aabbccddeeff001122334455#0",
    poolNft: POOLS[0].id,
    action: "withdraw",
    tokenA: ADA,
    tokenB: TEST,
    lp: "250000",
    minA: "100000000", // ≥100 ADA
    minB: "140000000",
    minShares: "0",
    tip: "1000000",
    deadline: null,
  },
  {
    ref: "00112233445566778899aabbccddeeff00112233445566778899aabb#0",
    poolNft: POOLS[0].id,
    action: "deposit",
    tokenA: ADA,
    tokenB: TEST,
    depositA: "50000000", // 50 ADA
    depositB: "70000000",
    minA: "0",
    minB: "0",
    minShares: "60000",
    tip: "1000000",
    deadline: null,
  },
];

export class MockProvider implements DataProvider {
  readonly name = "mock";

  async listTokens(): Promise<TokenInfo[]> {
    return TOKENS;
  }

  async listRegisteredTokens(units: string[]): Promise<TokenInfo[]> {
    // The mock treats its known fungible tokens as "the registry" — any held unit that
    // matches one of them is registered; everything else (a wallet's NFTs) is dropped.
    return units
      .map((u) => BY_UNIT.get(u))
      .filter((t): t is TokenInfo => !!t && t.unit !== "lovelace");
  }

  async listPools(): Promise<Pool[]> {
    return POOLS;
  }

  async getPool(poolId: string): Promise<Pool | null> {
    return POOLS.find((p) => p.id === poolId) ?? null;
  }

  async routeQuote(
    tokenInUnit: string,
    tokenOutUnit: string,
    amountIn: string,
    tipLovelace: string,
  ): Promise<Route | null> {
    if (!BY_UNIT.has(tokenInUnit) || !BY_UNIT.has(tokenOutUnit)) return null;
    // Same split router as the real provider, over the mock's pool set.
    return planRoute(POOLS, tokenInUnit, tokenOutUnit, amountIn, {
      tipLovelace: BigInt(tipLovelace),
    });
  }

  async referencePrice(): Promise<ReferencePrice | null> {
    // The offline mock has no external market — no reference price (the UI degrades to manual).
    return null;
  }

  async walletPositions(address: string): Promise<WalletPosition[]> {
    // Skeleton: return the same illustrative set regardless of address.
    void address;
    return POSITIONS;
  }

  async walletLpIntents(address: string): Promise<LpIntentPosition[]> {
    // Skeleton: return the same illustrative set regardless of address.
    void address;
    return LP_INTENTS;
  }

  // The mock has no chain access, so it cannot supply protocol params or evaluate a
  // tx. These only matter on the order build/reclaim paths, which require a real
  // provider; fail loudly rather than hand back fake values.
  async protocolParameters(): Promise<Protocol> {
    throw new Error("MockProvider cannot supply protocol parameters");
  }

  async costModels(): Promise<number[][]> {
    throw new Error("MockProvider cannot supply cost models");
  }

  async evaluateTx(): Promise<Omit<Action, "data">[]> {
    throw new Error("MockProvider cannot evaluate transactions");
  }

  async resolveUtxo(): Promise<UTxO | null> {
    throw new Error("MockProvider cannot resolve UTXOs");
  }

  async transactionConfirmed(): Promise<boolean> {
    // No real chain to confirm against — treat every tx as confirmed so the offline mock
    // never clears the Orders view's optimistic reclaim state. (Reclaim is a no-op here
    // anyway: resolveUtxo throws, so a reclaim never records a tx to verify.)
    return true;
  }

  async resolvePoolUtxo(): Promise<UTxO | null> {
    throw new Error("MockProvider cannot resolve UTXOs");
  }

  async poolMintInputs(): Promise<{ txHash: string; index: number }[]> {
    throw new Error("MockProvider cannot access transaction inputs");
  }
}
