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
import { quoteConstantProduct } from "./quote";
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

/** Resolved asset metadata (cached). `decimals` always present; rest best-effort. */
type AssetMeta = {
  decimals: number;
  ticker?: string;
  name?: string;
  icon?: string;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Transient HTTP/network errors worth retrying (rate-limit, 5xx, dropped conn). */
function isRetriable(e: unknown): boolean {
  const o = e as { status?: unknown; status_code?: unknown; message?: unknown };
  // MeshJS's BlockfrostProvider throws a JSON STRING (parseHttpError), so the real
  // HTTP status lives inside it — parse it out rather than digit-matching the text
  // (which would over-retry messages that merely contain "503" or "network").
  let status = numOr(o?.status) ?? numOr(o?.status_code);
  const text = typeof e === "string" ? e : String(o?.message ?? e ?? "");
  if (status === undefined) {
    try {
      const parsed = JSON.parse(text) as { status?: unknown; status_code?: unknown };
      status = numOr(parsed?.status) ?? numOr(parsed?.status_code);
    } catch {
      // not JSON — fall through to keyword matching
    }
  }
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  return /\b429\b|rate.?limit|too many requests|timeout|econnreset|etimedout|fetch failed/i.test(
    text,
  );
}

function numOr(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Retry a read with exponential backoff on transient failures. Read-only and
 * idempotent (pool/order/metadata/params/evaluate), so retrying is safe — Blockfrost
 * free tier rate-limits, and a single 429 shouldn't surface as a dead UI.
 */
async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !isRetriable(e)) throw e;
      await sleep(250 * 2 ** i); // 250ms, 500ms
    }
  }
  throw lastErr;
}


export class BlockfrostDataProvider implements DataProvider {
  readonly name = "blockfrost";
  private readonly bf: BlockfrostProvider;
  private readonly metaCache = new Map<string, AssetMeta>();
  private poolsCache?: { at: number; entries: PoolEntry[] };

  constructor(projectId: string) {
    this.bf = new BlockfrostProvider(projectId);
  }

  /**
   * Registry + on-chain metadata for an asset (cached on SUCCESS only).
   *
   * Decimals/ticker/logo for a fungible token live in the OFF-CHAIN token registry
   * (`data.metadata`, CIP-26) — MeshJS's `fetchAssetMetadata` returns only
   * `onchain_metadata` (CIP-25) and drops them, which would read every registry
   * token's decimals as 0 and mis-scale the posted amount by 10^decimals. So we fetch
   * the full asset record via `get('assets/…')` and prefer `metadata` (registry),
   * falling back to `onchain_metadata` for the name. A transient failure is NOT cached
   * (it would poison the singleton cache with decimals 0 until restart) — only a
   * confirmed lookup, even one with no metadata, is.
   */
  private async metaOf(unit: string): Promise<AssetMeta> {
    const cached = this.metaCache.get(unit);
    if (cached) return cached;
    let raw: { metadata?: unknown; onchain_metadata?: unknown };
    try {
      raw = (await retry(() => this.bf.get(`assets/${unit}`))) as typeof raw;
    } catch {
      return { decimals: 0 }; // transient/unknown — don't cache; retry next time
    }
    const reg = (raw?.metadata ?? {}) as Record<string, unknown>;
    const onchain = (raw?.onchain_metadata ?? {}) as Record<string, unknown>;
    const decimals =
      typeof reg.decimals === "number" && reg.decimals >= 0 ? reg.decimals : 0;
    const ticker = typeof reg.ticker === "string" ? reg.ticker : undefined;
    const name =
      typeof reg.name === "string"
        ? reg.name
        : typeof onchain.name === "string"
          ? onchain.name
          : undefined;
    // Registry `logo` is base64 PNG; only build a data-URI from base64 (never a URL).
    const logo = reg.logo;
    const icon =
      typeof logo === "string" && logo && !logo.includes("://")
        ? `data:image/png;base64,${logo}`
        : undefined;
    const meta: AssetMeta = { decimals, ticker, name, icon };
    this.metaCache.set(unit, meta);
    return meta;
  }

  /** Best-effort `TokenInfo`: metadata ticker/name/icon/decimals, else derive from the name. */
  private async tokenInfo(asset: AssetId): Promise<TokenInfo> {
    if (isAda(asset)) return ADA_TOKEN;
    const unit = assetUnit(asset);
    const meta = await this.metaOf(unit);
    const fallbackTicker = hexToAscii(asset.name) || unit.slice(0, 8);
    return {
      unit,
      ticker: meta.ticker || fallbackTicker,
      name: meta.name || meta.ticker || fallbackTicker,
      decimals: meta.decimals,
      icon: meta.icon,
    };
  }

  /** Decode the genuine pools at the pool address (cached briefly; deterministic order). */
  private async fetchPools(): Promise<PoolEntry[]> {
    const now = Date.now();
    if (this.poolsCache && now - this.poolsCache.at < POOLS_TTL_MS) {
      return this.poolsCache.entries;
    }
    const utxos = await retry(() => this.bf.fetchAddressUTxOs(POOL_ADDR));
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
    // When several pools trade the pair, quote against EACH and return the best
    // (highest output) — so the order binds (via quote.poolId) to the pool the user
    // was actually shown, and a second same-pair pool is reachable when it's better.
    const candidates = pools.filter(
      (p) =>
        (p.tokenA.unit === tokenInUnit && p.tokenB.unit === tokenOutUnit) ||
        (p.tokenA.unit === tokenOutUnit && p.tokenB.unit === tokenInUnit),
    );
    if (candidates.length === 0) return null;

    let best: Quote | null = null;
    for (const pool of candidates) {
      const q = quoteConstantProduct(pool, tokenInUnit, tokenOutUnit, amountIn);
      if (!best || toBig(q.amountOut) > toBig(best.amountOut)) best = q;
    }
    return best;
  }

  async walletPositions(address: string): Promise<WalletPosition[]> {
    const ownerPkh = deserializeAddress(address).pubKeyHash;
    if (!ownerPkh) return [];

    const [orderUtxos, pools] = await Promise.all([
      retry(() => this.bf.fetchAddressUTxOs(ORDER_ADDR)),
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
    return retry(() => this.bf.fetchProtocolParameters());
  }

  /**
   * The network's Plutus cost models as ordered `[v1, v2, v3]` parameter arrays. Read
   * from Blockfrost's `epochs/latest/parameters.cost_models_raw` (the canonical, ledger-
   * ordered integer arrays — NOT the named `cost_models` map, whose key order is not
   * guaranteed). Empty arrays for any absent language. `fetchProtocolParameters` drops
   * these, so we fetch the raw record directly.
   */
  async costModels(): Promise<number[][]> {
    const raw = (await retry(() =>
      this.bf.get("epochs/latest/parameters"),
    )) as { cost_models_raw?: Record<string, number[] | null> | null };
    const cm = raw?.cost_models_raw ?? {};
    return [cm.PlutusV1 ?? [], cm.PlutusV2 ?? [], cm.PlutusV3 ?? []];
  }

  evaluateTx(txCbor: string): Promise<Omit<Action, "data">[]> {
    return retry(() => this.bf.evaluateTx(txCbor));
  }

  async resolveUtxo(txHash: string, index: number): Promise<UTxO | null> {
    const utxos = await retry(() => this.bf.fetchUTxOs(txHash, index));
    const u = utxos[0];
    if (!u) return null;
    // `fetchUTxOs` (txs/{hash}/utxos) returns a tx's outputs even after they are
    // spent, so confirm this output is still UNSPENT at its address before handing
    // it to the reclaim builder — otherwise reclaim builds a doomed tx instead of
    // surfacing the clean "already spent / settled" message (provider contract).
    const live = await retry(() => this.bf.fetchAddressUTxOs(u.output.address));
    const stillUnspent = live.some(
      (x) => x.input.txHash === txHash && x.input.outputIndex === index,
    );
    return stillUnspent ? u : null;
  }

  async resolvePoolUtxo(poolNftUnit: string): Promise<UTxO | null> {
    // Live UTXOs at the pool address; the genuine pool is the one holding exactly one
    // of the requested NFT with a decodable inline `PoolDatum` (same identity rule as
    // `fetchPools` / the batcher's `find_pools`). `fetchAddressUTxOs` returns only
    // UNSPENT outputs, so this is already the live UTXO the LP builder must spend.
    const utxos = await retry(() => this.bf.fetchAddressUTxOs(POOL_ADDR));
    for (const u of utxos) {
      if (qtyOfUnit(u.output.amount, poolNftUnit) !== 1n) continue;
      const cbor = u.output.plutusData;
      if (!cbor) continue;
      try {
        decodePoolDatum(cbor);
      } catch {
        continue; // not a pool — skip
      }
      return u;
    }
    return null;
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
    partial: d.partial,
  };
}

function toBig(s: string): bigint {
  try {
    return BigInt(s.split(".")[0] || "0");
  } catch {
    return 0n;
  }
}
