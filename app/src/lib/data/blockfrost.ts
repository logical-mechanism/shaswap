import {
  type Action,
  BlockfrostProvider,
  deserializeAddress,
  type Protocol,
  type UTxO,
} from "@meshsdk/core";
import {
  type AssetId,
  assetUnit,
  decodeLpIntentDatum,
  decodeOrderDatum,
  decodePoolDatum,
  isAda,
  type LpIntentDatum,
  type OrderDatum,
} from "@/lib/chain/datums";
import {
  DEPLOYMENT_NETWORK_ID,
  lpUnitForPool,
  ORDER_ADDR,
  POOL_ADDR,
  TOTAL_LP,
} from "@/lib/chain/deployment";
import { lpIntentAddress } from "@/lib/chain/lpIntentScript";
import type { DataProvider } from "./provider";
import { quoteConstantProduct } from "./quote";
import { planRoute } from "./route";
import { getReferencePrice } from "./referencePrice";
import { feeToBps, httpStatus, isRetriable } from "./providerUtil";
import { qtyOfUnit, reserveOf, toLpIntentPosition, toPosition } from "./providerMap";
import type {
  LpIntentPosition,
  Pool,
  Quote,
  ReferencePrice,
  Route,
  TokenInfo,
  WalletPosition,
} from "./types";
import { toBigInt as toBig } from "../bigint";
import { errText, log } from "../log";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
      log.warn("provider retry", { attempt: i + 1, of: attempts, err: errText(e, 120) });
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
      // Circulating LP = total_lp − (LP held in the pool UTXO); none circulating ⇒ the
      // pool has never been seeded (the next deposit is the seeding first deposit).
      const nftUnit = assetUnit(datum.nft);
      const heldLp = qtyOfUnit(u.output.amount, lpUnitForPool(nftUnit));
      out.push({
        datum,
        pool: {
          id: nftUnit,
          tokenA,
          tokenB,
          reserveA: reserveOf(u.output.amount, datum.assetA).toString(),
          reserveB: reserveOf(u.output.amount, datum.assetB).toString(),
          feeBps: feeToBps(datum.feeNum, datum.feeDen),
          firstDeposit: TOTAL_LP - heldLp === 0n,
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

  /**
   * `TokenInfo` for a unit IFF it is in the CIP-26 off-chain token registry (a real
   * fungible token); `null` for NFTs, unregistered assets, or a transient/failed lookup.
   *
   * The signal is Blockfrost's `assets/{unit}.metadata` (the registry record), which is
   * non-null only for registered tokens — an NFT carries only `onchain_metadata` (CIP-25)
   * and has no `metadata`. We require at least a ticker or name so a thin/empty registry
   * stub doesn't surface as a nameless token.
   */
  private async registeredTokenInfo(unit: string): Promise<TokenInfo | null> {
    let raw: { metadata?: unknown };
    try {
      raw = (await retry(() => this.bf.get(`assets/${unit}`))) as typeof raw;
    } catch {
      return null; // transient/unknown — don't surface as a selectable token
    }
    const reg = raw?.metadata;
    if (!reg || typeof reg !== "object") return null; // no CIP-26 entry ⇒ not in the register
    const m = reg as Record<string, unknown>;
    const ticker = typeof m.ticker === "string" ? m.ticker : undefined;
    const name = typeof m.name === "string" ? m.name : undefined;
    if (!ticker && !name) return null;
    const decimals =
      typeof m.decimals === "number" && m.decimals >= 0 ? m.decimals : 0;
    // Registry `logo` is base64 PNG; only build a data-URI from base64 (never a URL).
    const logo = m.logo;
    const icon =
      typeof logo === "string" && logo && !logo.includes("://")
        ? `data:image/png;base64,${logo}`
        : undefined;
    const fallbackTicker = hexToAscii(unit.slice(56)) || unit.slice(0, 8);
    return {
      unit,
      ticker: ticker || fallbackTicker,
      name: name || ticker || fallbackTicker,
      decimals,
      icon,
    };
  }

  async listRegisteredTokens(units: string[]): Promise<TokenInfo[]> {
    const uniq = [...new Set(units)].filter((u) => u && u !== "lovelace");
    // Bound the fan-out: a wallet can hold hundreds of assets, but each is one Blockfrost
    // read. Cap it (loudly — never silently) so the registry filter can't melt the free tier.
    const MAX_SCAN = 80;
    const scan = uniq.slice(0, MAX_SCAN);
    if (uniq.length > scan.length) {
      log.warn("registered-token scan capped", {
        held: uniq.length,
        scanned: scan.length,
      });
    }
    // Small concurrency so we respect rate limits but don't serialize a big wallet.
    const CONCURRENCY = 6;
    const out: TokenInfo[] = [];
    for (let i = 0; i < scan.length; i += CONCURRENCY) {
      const chunk = scan.slice(i, i + CONCURRENCY);
      const infos = await Promise.all(chunk.map((u) => this.registeredTokenInfo(u)));
      for (const info of infos) if (info) out.push(info);
    }
    return out;
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

  async routeQuote(
    tokenInUnit: string,
    tokenOutUnit: string,
    amountIn: string,
    tipLovelace: string,
  ): Promise<Route | null> {
    // Same pool list `priceQuote` quotes against — the split router (pure) does the rest:
    // it picks the best split across the pair's shards, gated by the per-leg tip.
    const pools = await this.listPools();
    return planRoute(pools, tokenInUnit, tokenOutUnit, amountIn, {
      tipLovelace: toBig(tipLovelace),
    });
  }

  referencePrice(
    tokenAUnit: string,
    tokenBUnit: string,
  ): Promise<ReferencePrice | null> {
    // Sourced externally (free public DEX), not from Blockfrost — see referencePrice.ts.
    return getReferencePrice(tokenAUnit, tokenBUnit);
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

  async walletLpIntents(address: string): Promise<LpIntentPosition[]> {
    const ownerPkh = deserializeAddress(address).pubKeyHash;
    if (!ownerPkh) return [];

    // The lp_intent enterprise address (stake = None) — derived, S-applied. On a network where
    // the LP-intent path isn't live (preview) it has no history; a 404 from Blockfrost
    // for a never-used address is "no intents", not an error.
    const addr = lpIntentAddress(DEPLOYMENT_NETWORK_ID);
    let utxos;
    try {
      utxos = await retry(() => this.bf.fetchAddressUTxOs(addr));
    } catch (e) {
      if (httpStatus(e) === 404) return [];
      throw e;
    }
    const pools = await this.fetchPools();
    const poolByNft = new Map(pools.map((p) => [p.pool.id, p.pool]));

    const intents: LpIntentPosition[] = [];
    for (const u of utxos) {
      const cbor = u.output.plutusData;
      if (!cbor) continue;
      let d: LpIntentDatum;
      try {
        d = decodeLpIntentDatum(cbor);
      } catch {
        continue; // junk parked at the public lp_intent address — skip
      }
      if (d.owner.kind !== "key" || d.owner.hash !== ownerPkh) continue;
      intents.push(toLpIntentPosition(u, d, poolByNft.get(assetUnit(d.poolNft))));
    }
    return intents;
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

  async transactionConfirmed(txHash: string): Promise<boolean> {
    // `txs/{hash}` is 200 once the tx is in a block, and 404 while it is unknown /
    // mempool-only — so a 404 is the definitive "not confirmed". Any other (transient)
    // error propagates: the caller must not read a rate-limit/5xx as "didn't land" and
    // clear a reclaim that actually succeeded.
    try {
      await retry(() => this.bf.get(`txs/${txHash}`));
      return true;
    } catch (e) {
      if (httpStatus(e) === 404) return false;
      throw e;
    }
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

  async poolMintInputs(
    poolNftUnit: string,
  ): Promise<{ txHash: string; index: number }[]> {
    // The pool NFT was minted in the pool's creation tx, whose inputs include the
    // one-shot seed. `assets/{unit}.initial_mint_tx_hash` → that tx; `txs/{hash}/utxos`
    // → its `inputs[]` (kept even after they're spent). The client tests each input
    // against the pool's policy id to recover the seed (pure — see closePool.ts).
    const asset = (await retry(() =>
      this.bf.get(`assets/${poolNftUnit}`),
    )) as { initial_mint_tx_hash?: string };
    const mintTx = asset?.initial_mint_tx_hash;
    if (!mintTx) return [];
    const tx = (await retry(() => this.bf.get(`txs/${mintTx}/utxos`))) as {
      inputs?: { tx_hash: string; output_index: number }[];
    };
    return (tx?.inputs ?? []).map((i) => ({
      txHash: i.tx_hash,
      index: i.output_index,
    }));
  }
}
