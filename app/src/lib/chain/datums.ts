/**
 * Plutus `Data` codec for the ShaSwap on-chain datums/redeemers.
 *
 * This is the TS mirror of the Aiken schema in `contracts/plutus.json` and the Rust
 * encoder in `batcher/crates/txbuild/src/plutus.rs`. Constructor indices and field
 * order are the make-or-break detail — a wrong tag or reordered field decodes to a
 * different value and the validator rejects (or, worse, silently mis-posts). The
 * `datums.test.ts` suite byte-verifies the output against known CBOR fixtures.
 *
 * Mapping (confirmed against `plutus.json` / `plutus.rs`):
 *  - `AssetId`        → `Constr 0 [policy, name]`            (ADA = `Constr 0 [h'', h'']`)
 *  - `Credential`     → key `Constr 0 [hash]`, script `Constr 1 [hash]`
 *  - `OutputReference`→ `Constr 0 [tx_id, index]`
 *  - `OrderDatum`     → `Constr 0 [owner, owner_stake, pool_nft, sell_a, sell_amount,
 *                                  limit, tip, partial, deadline]`
 *  - `PoolDatum`      → `Constr 0 [nft, asset_a, asset_b, fee_num, fee_den, creator]`
 *  - `BoundDatum`     → `Constr 0 [order_ref]`
 *  - `Bool`           → `False = Constr 0 []`, `True = Constr 1 []`
 *  - `Option`         → `Some(x) = Constr 0 [x]`, `None = Constr 1 []`
 *  - `OrderRedeemer`  → `Settle = Constr 0 []`, `Reclaim = Constr 1 []`
 *
 * MeshJS's `mConStr`/`serializeData` produce byte-identical CBOR to the pallas
 * encoder (verified: `d87980`, `d8799f4040ff`, full order datum) — so building on
 * them keeps the app and the batcher in lockstep.
 */

import {
  type Data,
  deserializeDatum,
  mConStr,
  serializeData,
} from "@meshsdk/core";

// ---- domain chain types (distinct from the UI types in lib/data/types.ts) ----

/** A `(policy, name)` native-asset id, hex strings. ADA = `{ policy: "", name: "" }`. */
export interface AssetId {
  policy: string;
  name: string;
}

/** A spending credential. Order owners MUST be `key` to keep `Reclaim` working. */
export type Credential =
  | { kind: "key"; hash: string }
  | { kind: "script"; hash: string };

/** A UTXO reference (`${txHash}#${index}`-equivalent, structured). */
export interface OutputReference {
  txHash: string;
  index: number;
}

/** `types.OrderDatum` — a trade intent against one pool's `(asset_a, asset_b)`. */
export interface OrderDatum {
  owner: Credential;
  /**
   * The owner's chosen stake credential for the settled-funds payout. A non-null
   * value makes the payout land at a **base** address (delegating/Lace-style wallets
   * show + spend it); `null` is an enterprise payout. Pinned from the datum, so the
   * solver can't redirect it (audit M-01).
   */
  ownerStake: Credential | null;
  poolNft: AssetId;
  /** `true` sells `asset_a` for `asset_b`; `false` sells `asset_b` for `asset_a`. */
  sellA: boolean;
  sellAmount: bigint;
  /** Minimum amount of the *bought* asset — the per-order floor (§5.2.5). */
  limit: bigint;
  tip: bigint;
  partial: boolean;
  /** Optional settlement deadline (POSIX ms). */
  deadline: bigint | null;
}

/** `types.PoolDatum` — pool identity + traded pair + static fee. */
export interface PoolDatum {
  nft: AssetId;
  assetA: AssetId;
  assetB: AssetId;
  feeNum: bigint;
  feeDen: bigint;
  creator: Credential;
}

/** ADA is the empty `(policy, name)` asset. */
export const ADA: AssetId = { policy: "", name: "" };

export function isAda(a: AssetId): boolean {
  return a.policy === "" && a.name === "";
}

/** The on-chain `unit` of an asset: "lovelace" for ADA, else `policy + name`. */
export function assetUnit(a: AssetId): string {
  return isAda(a) ? "lovelace" : a.policy + a.name;
}

/** Parse a UI `unit` ("lovelace" or `policy(56)+nameHex`) back into an `AssetId`. */
export function assetFromUnit(unit: string): AssetId {
  if (unit === "lovelace" || unit === "") return ADA;
  // Must be a 28-byte policy (56 hex) + an even-length name. Reject odd-length hex:
  // MeshJS's `mConStr` silently encodes an odd-length string as raw TEXT, not bytes,
  // which would mint/encode a different on-chain asset than intended.
  if (!/^[0-9a-fA-F]+$/.test(unit) || unit.length < 56 || unit.length % 2 !== 0) {
    throw new Error(`malformed asset unit: ${unit}`);
  }
  return { policy: unit.slice(0, 56).toLowerCase(), name: unit.slice(56).toLowerCase() };
}

// ---- encoders (→ Mesh `Data`, default "Mesh" type for txOutInlineDatumValue) ----

function bool(b: boolean): Data {
  return mConStr(b ? 1 : 0, []);
}

function optionInt(v: bigint | null): Data {
  return v === null ? mConStr(1, []) : mConStr(0, [v]);
}

function optionCredential(c: Credential | null): Data {
  return c === null ? mConStr(1, []) : mConStr(0, [encodeCredential(c)]);
}

export function encodeAssetId(a: AssetId): Data {
  return mConStr(0, [a.policy, a.name]);
}

export function encodeCredential(c: Credential): Data {
  return mConStr(c.kind === "key" ? 0 : 1, [c.hash]);
}

export function encodeOutputReference(r: OutputReference): Data {
  return mConStr(0, [r.txHash, BigInt(r.index)]);
}

export function encodeOrderDatum(d: OrderDatum): Data {
  return mConStr(0, [
    encodeCredential(d.owner),
    optionCredential(d.ownerStake),
    encodeAssetId(d.poolNft),
    bool(d.sellA),
    d.sellAmount,
    d.limit,
    d.tip,
    bool(d.partial),
    optionInt(d.deadline),
  ]);
}

export function encodePoolDatum(d: PoolDatum): Data {
  return mConStr(0, [
    encodeAssetId(d.nft),
    encodeAssetId(d.assetA),
    encodeAssetId(d.assetB),
    d.feeNum,
    d.feeDen,
    encodeCredential(d.creator),
  ]);
}

export function encodeBoundDatum(orderRef: OutputReference): Data {
  return mConStr(0, [encodeOutputReference(orderRef)]);
}

/** `OrderRedeemer::Settle` / `Reclaim` (nullary). */
export const orderSettleRedeemer: Data = mConStr(0, []);
export const orderReclaimRedeemer: Data = mConStr(1, []);

/**
 * `PoolRedeemer` (nullary). Mirrors `types.PoolRedeemer`:
 *  - `PoolSettle = Constr 0 []` (spent inside a settlement),
 *  - `LpAction   = Constr 1 []` (the standalone LP deposit/withdraw, §6),
 *  - `ClosePool  = Constr 2 []` (tear down a never-seeded pool).
 * The LP write paths (deposit/withdraw) spend the pool UTXO with `lpActionRedeemer`.
 */
export const poolSettleRedeemer: Data = mConStr(0, []);
export const lpActionRedeemer: Data = mConStr(1, []);
export const closePoolRedeemer: Data = mConStr(2, []);

/**
 * `MintRedeemer` (nullary) for a pool's one-shot mint policy `pool_mint(seed)`:
 *  - `Create = Constr 0 []` (mint `{NFT:1, LP:total_lp}` for a new pool, §5.1),
 *  - `Close  = Constr 1 []` (burn them to tear down a never-seeded pool).
 * Named `mint*` to keep distinct from the pool-SPEND `closePoolRedeemer` (Constr 2) above —
 * the mint `Close` is constructor 1, a different validator entirely.
 */
export const mintCreateRedeemer: Data = mConStr(0, []);
export const mintCloseRedeemer: Data = mConStr(1, []);

/** Canonical CBOR hex of any `Data` (handy for tests / byte-verification). */
export function toCbor(d: Data): string {
  return serializeData(d);
}

// ---- decoders (← Blockfrost inline-datum CBOR via deserializeDatum) ----

/** The JSON `Data` shape `deserializeDatum` returns (bigints for ints/constr). */
type PlutusJson =
  | { int: bigint }
  | { bytes: string }
  | { list: PlutusJson[] }
  | { map: { k: PlutusJson; v: PlutusJson }[] }
  | { constructor: bigint; fields: PlutusJson[] };

type Constr = { constructor: bigint; fields: PlutusJson[] };

// Discriminate on `fields` (only the constructor node has it) — `"constructor" in d`
// is no good for narrowing since every object inherits `Object.prototype.constructor`.
function isConstr(d: PlutusJson): d is Constr {
  return "fields" in d;
}

/** Narrow to a constructor node and read its 0-based index + fields. */
function readConstr(d: PlutusJson, index?: number): { index: number; fields: PlutusJson[] } {
  if (!isConstr(d)) throw new Error("expected a constructor");
  const idx = Number(d.constructor);
  if (index !== undefined && idx !== index) {
    throw new Error(`expected constructor ${index}, got ${idx}`);
  }
  return { index: idx, fields: d.fields };
}

function asConstr(d: PlutusJson, index?: number): PlutusJson[] {
  return readConstr(d, index).fields;
}

function asBytes(d: PlutusJson): string {
  if (!("bytes" in d)) throw new Error("expected a byte string");
  return d.bytes;
}

function asInt(d: PlutusJson): bigint {
  if (!("int" in d)) throw new Error("expected an integer");
  return d.int;
}

function decodeAssetId(d: PlutusJson): AssetId {
  const [policy, name] = asConstr(d, 0);
  return { policy: asBytes(policy), name: asBytes(name) };
}

function decodeCredential(d: PlutusJson): Credential {
  const { index, fields } = readConstr(d);
  const hash = asBytes(fields[0]);
  if (index === 0) return { kind: "key", hash };
  if (index === 1) return { kind: "script", hash };
  throw new Error(`unknown credential constructor ${index}`);
}

function decodeOptionInt(d: PlutusJson): bigint | null {
  const { index, fields } = readConstr(d);
  if (index === 1) return null;
  if (index === 0) return asInt(fields[0]);
  throw new Error(`unknown Option constructor ${index}`);
}

function decodeOptionCredential(d: PlutusJson): Credential | null {
  const { index, fields } = readConstr(d);
  if (index === 1) return null;
  if (index === 0) return decodeCredential(fields[0]);
  throw new Error(`unknown Option constructor ${index}`);
}

function decodeBool(d: PlutusJson): boolean {
  const { index } = readConstr(d);
  if (index === 1) return true;
  if (index === 0) return false;
  throw new Error(`unknown Bool constructor ${index}`);
}

/** Decode an inline `OrderDatum` from its CBOR hex. Throws on any malformed input. */
export function decodeOrderDatum(cborHex: string): OrderDatum {
  const root = deserializeDatum<PlutusJson>(cborHex);
  const f = asConstr(root, 0);
  if (f.length !== 9) throw new Error(`OrderDatum: expected 9 fields, got ${f.length}`);
  return {
    owner: decodeCredential(f[0]),
    ownerStake: decodeOptionCredential(f[1]),
    poolNft: decodeAssetId(f[2]),
    sellA: decodeBool(f[3]),
    sellAmount: asInt(f[4]),
    limit: asInt(f[5]),
    tip: asInt(f[6]),
    partial: decodeBool(f[7]),
    deadline: decodeOptionInt(f[8]),
  };
}

/** Decode an inline `PoolDatum` from its CBOR hex. Throws on any malformed input. */
export function decodePoolDatum(cborHex: string): PoolDatum {
  const root = deserializeDatum<PlutusJson>(cborHex);
  const f = asConstr(root, 0);
  if (f.length !== 6) throw new Error(`PoolDatum: expected 6 fields, got ${f.length}`);
  return {
    nft: decodeAssetId(f[0]),
    assetA: decodeAssetId(f[1]),
    assetB: decodeAssetId(f[2]),
    feeNum: asInt(f[3]),
    feeDen: asInt(f[4]),
    creator: decodeCredential(f[5]),
  };
}
