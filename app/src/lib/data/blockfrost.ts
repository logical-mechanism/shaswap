import {
  type Action,
  type Asset,
  BlockfrostProvider,
  deserializeAddress,
  type Protocol,
  type UTxO,
} from "@meshsdk/core";
import {
  type AssetId,
  assetUnit,
  decodeOrderDatum,
  decodePoolDatum,
  isAda,
  type OrderDatum,
} from "@/lib/chain/datums";
import {
  ORDER_ADDR,
  POOL_ADDR,
  POOL_MIN_ADA,
} from "@/lib/chain/deployment";
import type { DataProvider } from "./provider";
import type { Pool, Quote, TokenInfo, WalletPosition } from "./types";

/**
 * Real preprod `DataProvider` backed by Blockfrost (the user's chosen hosted
 * provider), behind the data-access seam. This file is **server-only** — it is
 * instantiated solely from `getDataProvider()` (called by `/api/*` route handlers),
 * so the project id never reaches the browser. The client only ever fetches `/api/*`.
 *
 * Pools/orders are discovered at the `S`-tagged pool/order addresses
 * (`deployment.ts`). Pools are identified **generically** — a UTXO is a pool iff it
 * holds exactly one of the NFT its own `PoolDatum` declares — mirroring the batcher's
 * `find_pools` (each pool has its own one-shot mint policy, so there's no global
 * policy filter). Reserves are read from the UTXO value with `pool_min_ada` carved
 * out of an ADA reserve (BLUEPRINT §5.2.1 / `reserve_of`).
 *
 * `priceQuote` is a plain constant-product estimate over the *real* reserves — for
 * display only. It is NOT ShaSwap's batch-auction clearing; the user posts an intent
 * and the untrusted solver settles it later, never worse than the per-order floor.
 */

const ADA_TOKEN: TokenInfo = {
  unit: "lovelace",
  ticker: "ADA",
  name: "Cardano",
  decimals: 6,
};

/** Decode a printable-ASCII asset name (e.g. 54455354 → "TEST"); else "". */
function hexToAscii(hex: string): string {
  if (!hex) return "";
  try {
    const s = Buffer.from(hex, "hex").toString("utf8");
    return /^[\x20-\x7e]+$/.test(s) ? s : "";
  } catch {
    return "";
  }
}

/** A decoded pool plus the raw datum it came from. */
type PoolEntry = { pool: Pool; datum: ReturnType<typeof decodePoolDatum> };

/** How long a decoded-pool snapshot is reused before re-scanning the pool address. */
const POOLS_TTL_MS = 6_000;

/** Quantity of `unit` in a Mesh value, as bigint. */
function qtyOfUnit(amount: Asset[], unit: string): bigint {
  const found = amount.find((a) => a.unit === unit);
  return found ? BigInt(found.quantity) : 0n;
}

/** Reserve of `asset` in a pool value: its quantity, minus min-ADA if it is ADA. */
function reserveOf(amount: Asset[], asset: AssetId): bigint {
  const q = qtyOfUnit(amount, assetUnit(asset));
  const r = isAda(asset) ? q - POOL_MIN_ADA : q;
  return r < 0n ? 0n : r;
}

/** Static fee `fee_num/fee_den` → integer basis points (3/1000 → 30). */
function feeToBps(feeNum: bigint, feeDen: bigint): number {
  if (feeDen <= 0n) return 0;
  return Number((feeNum * 10_000n) / feeDen);
}

/** Find the pool trading exactly {inUnit, outUnit} in either direction. */
function findPool(pools: Pool[], inUnit: string, outUnit: string): Pool | undefined {
  return pools.find(
    (p) =>
      (p.tokenA.unit === inUnit && p.tokenB.unit === outUnit) ||
      (p.tokenA.unit === outUnit && p.tokenB.unit === inUnit),
  );
}

export class BlockfrostDataProvider implements DataProvider {
  readonly name = "blockfrost";
  private readonly bf: BlockfrostProvider;
  private readonly decimalsCache = new Map<string, number>();
  private poolsCache?: { at: number; entries: PoolEntry[] };

  constructor(projectId: string) {
    this.bf = new BlockfrostProvider(projectId);
  }

  /** Decimals for an asset: ADA = 6; native tokens from registry metadata (cached, fallback 0). */
  private async decimalsOf(asset: AssetId): Promise<number> {
    if (isAda(asset)) return 6;
    const unit = assetUnit(asset);
    const cached = this.decimalsCache.get(unit);
    if (cached !== undefined) return cached;
    let decimals = 0;
    try {
      const meta = (await this.bf.fetchAssetMetadata(unit)) as
        | { decimals?: number }
        | undefined;
      if (meta && typeof meta.decimals === "number" && meta.decimals >= 0) {
        decimals = meta.decimals;
      }
    } catch {
      // no registry entry / fetch error → treat as 0 (raw base units)
    }
    this.decimalsCache.set(unit, decimals);
    return decimals;
  }

  /** Best-effort `TokenInfo`: ticker from the asset name, decimals from metadata. */
  private async tokenInfo(asset: AssetId): Promise<TokenInfo> {
    if (isAda(asset)) return ADA_TOKEN;
    const unit = assetUnit(asset);
    const ticker = hexToAscii(asset.name) || unit.slice(0, 8);
    return { unit, ticker, name: ticker, decimals: await this.decimalsOf(asset) };
  }

  /** Decode the genuine pools at the pool address (cached briefly; deterministic order). */
  private async fetchPools(): Promise<PoolEntry[]> {
    const now = Date.now();
    if (this.poolsCache && now - this.poolsCache.at < POOLS_TTL_MS) {
      return this.poolsCache.entries;
    }
    const utxos = await this.bf.fetchAddressUTxOs(POOL_ADDR);
    const out: PoolEntry[] = [];
    for (const u of utxos) {
      const cbor = u.output.plutusData;
      if (!cbor) continue;
      let datum;
      try {
        datum = decodePoolDatum(cbor);
      } catch {
        continue; // not a pool — skip (the address is public; anyone can park junk)
      }
      // A genuine pool holds exactly one of the NFT it declares (batcher find_pools).
      if (qtyOfUnit(u.output.amount, assetUnit(datum.nft)) !== 1n) continue;
      const [tokenA, tokenB] = await Promise.all([
        this.tokenInfo(datum.assetA),
        this.tokenInfo(datum.assetB),
      ]);
      out.push({
        datum,
        pool: {
          id: assetUnit(datum.nft),
          tokenA,
          tokenB,
          reserveA: reserveOf(u.output.amount, datum.assetA).toString(),
          reserveB: reserveOf(u.output.amount, datum.assetB).toString(),
          feeBps: feeToBps(datum.feeNum, datum.feeDen),
        },
      });
    }
    // Deterministic order (by pool NFT) so independent reads agree on first-match.
    out.sort((a, b) => (a.pool.id < b.pool.id ? -1 : a.pool.id > b.pool.id ? 1 : 0));
    this.poolsCache = { at: now, entries: out };
    return out;
  }

  async listPools(): Promise<Pool[]> {
    return (await this.fetchPools()).map((p) => p.pool);
  }

  async getPool(poolId: string): Promise<Pool | null> {
    return (await this.listPools()).find((p) => p.id === poolId) ?? null;
  }

  async listTokens(): Promise<TokenInfo[]> {
    const pools = await this.listPools();
    const byUnit = new Map<string, TokenInfo>([[ADA_TOKEN.unit, ADA_TOKEN]]);
    for (const p of pools) {
      byUnit.set(p.tokenA.unit, p.tokenA);
      byUnit.set(p.tokenB.unit, p.tokenB);
    }
    return [...byUnit.values()];
  }

  async priceQuote(
    tokenInUnit: string,
    tokenOutUnit: string,
    amountIn: string,
  ): Promise<Quote | null> {
    const pools = await this.listPools();
    const pool = findPool(pools, tokenInUnit, tokenOutUnit);
    if (!pool) return null;
    const tokenIn = pool.tokenA.unit === tokenInUnit ? pool.tokenA : pool.tokenB;
    const tokenOut = pool.tokenA.unit === tokenOutUnit ? pool.tokenA : pool.tokenB;

    const amtIn = toBig(amountIn);
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

    // Constant-product with fee — display estimate only, NOT the protocol clearing.
    const feeBps = BigInt(pool.feeBps);
    const inAfterFee = (amtIn * (10_000n - feeBps)) / 10_000n;
    const amountOut = (reserveOut * inAfterFee) / (reserveIn + inAfterFee);

    const SCALE = 1_000_000n;
    const midScaled = (reserveOut * SCALE) / reserveIn;
    const execScaled = (amountOut * SCALE) / amtIn;
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
    const ownerPkh = deserializeAddress(address).pubKeyHash;
    if (!ownerPkh) return [];

    const [orderUtxos, pools] = await Promise.all([
      this.bf.fetchAddressUTxOs(ORDER_ADDR),
      this.fetchPools(),
    ]);
    const poolByNft = new Map(pools.map((p) => [p.pool.id, p.pool]));

    const positions: WalletPosition[] = [];
    for (const u of orderUtxos) {
      const cbor = u.output.plutusData;
      if (!cbor) continue;
      let d: OrderDatum;
      try {
        d = decodeOrderDatum(cbor);
      } catch {
        continue; // junk parked at the public order address — skip
      }
      if (d.owner.kind !== "key" || d.owner.hash !== ownerPkh) continue;
      positions.push(toPosition(u, d, poolByNft.get(assetUnit(d.poolNft))));
    }
    return positions;
  }

  protocolParameters(): Promise<Protocol> {
    return this.bf.fetchProtocolParameters();
  }

  evaluateTx(txCbor: string): Promise<Omit<Action, "data">[]> {
    return this.bf.evaluateTx(txCbor);
  }

  async resolveUtxo(txHash: string, index: number): Promise<UTxO | null> {
    const utxos = await this.bf.fetchUTxOs(txHash, index);
    const u = utxos[0];
    if (!u) return null;
    // `fetchUTxOs` (txs/{hash}/utxos) returns a tx's outputs even after they are
    // spent, so confirm this output is still UNSPENT at its address before handing
    // it to the reclaim builder — otherwise reclaim builds a doomed tx instead of
    // surfacing the clean "already spent / settled" message (provider contract).
    const live = await this.bf.fetchAddressUTxOs(u.output.address);
    const stillUnspent = live.some(
      (x) => x.input.txHash === txHash && x.input.outputIndex === index,
    );
    return stillUnspent ? u : null;
  }
}

/** Map an order UTXO + datum (+ its pool, if on-chain) to a UI `WalletPosition`. */
function toPosition(u: UTxO, d: OrderDatum, pool: Pool | undefined): WalletPosition {
  // Bought/sold assets follow from sell_a + the pool pair (the datum stores only the
  // pool NFT). If the pool isn't on-chain (orphan order), show placeholders — the
  // order is still owner-reclaimable, which is what matters here.
  const unknown: TokenInfo = {
    unit: assetUnit(d.poolNft),
    ticker: "?",
    name: "unknown pool",
    decimals: 0,
  };
  const a = pool?.tokenA ?? unknown;
  const b = pool?.tokenB ?? unknown;
  const tokenIn = d.sellA ? a : b;
  const tokenOut = d.sellA ? b : a;
  return {
    ref: `${u.input.txHash}#${u.input.outputIndex}`,
    tokenIn,
    tokenOut,
    amountIn: d.sellAmount.toString(),
    minOut: d.limit.toString(),
    status: "open",
  };
}

function toBig(s: string): bigint {
  try {
    return BigInt(s.split(".")[0] || "0");
  } catch {
    return 0n;
  }
}
