"use client";

/**
 * Create a new ShaSwap pool (mint its one-shot NFT + LP supply). Pool creation is
 * permissionless — anyone may create a pool (a hyperstructure requirement). The page
 * picks two distinct assets + a fee, then `createPool` (in `lib/client/tx.ts`)
 * instantiates the per-pool `pool_mint(seed)` policy client-side, mints
 * `{NFT:1, LP:total_lp}`, and locks them into a single EMPTY pool UTXO at the shared
 * pool address. The creator then seeds the first liquidity via the existing deposit flow
 * (`/pools/[id]`) — surfaced as a CTA on success.
 *
 * Token universe = the connected wallet's held assets + ADA (creating a pool only needs
 * each asset's unit; the existing read-only token list only includes tokens already in a
 * pool, so it can't surface a brand-new token). ADA is normalised to `asset_b` on submit
 * to match the live pool orientation.
 */

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAssets, useWallet } from "@meshsdk/react";
import type { TokenInfo } from "@/lib/data";
import { explorerTxUrl } from "@/lib/config";
import { usePools } from "@/hooks/usePools";
import { useWriteGate } from "@/hooks/useWriteGate";
import { toUserMessage } from "@/lib/client/errors";
import { TokenSelect } from "@/components/swap/TokenSelect";
import { truncate, withinDecimals } from "@/lib/format";
import { Pip } from "@/components/Pip";
import { PipOverlay } from "@/components/PipOverlay";
import { Confetti } from "@/components/Confetti";
import { CollateralNote } from "@/components/CollateralNote";

type TxState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "success"; hash: string; poolId: string }
  | { kind: "error"; message: string };

const ADA_TOKEN: TokenInfo = {
  unit: "lovelace",
  ticker: "ADA",
  name: "Cardano",
  decimals: 6,
};

/** Decode a hex byte string to text (latin1 is fine for ASCII tickers); "" on odd len. */
function hexToText(hex: string): string {
  if (hex.length % 2 !== 0) return "";
  let s = "";
  for (let i = 0; i < hex.length; i += 2) {
    s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return s;
}

/**
 * Minimal `TokenInfo` for a wallet-held asset, by unit. Creation needs only the unit, so
 * we derive a friendly ticker from the asset name (printable ASCII) and fall back to a
 * truncated unit; decimals are display-only and don't affect the (empty-pool) mint.
 */
function walletTokenInfo(unit: string): TokenInfo {
  const nameHex = unit.slice(56);
  const decoded = hexToText(nameHex);
  const ticker =
    decoded && /^[\x20-\x7e]+$/.test(decoded) ? decoded : truncate(unit, 6, 4);
  return { unit, ticker, name: ticker, decimals: 0 };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

/** Basis points → a reduced `fee_num/fee_den` (e.g. 30 bps → 3/1000; 0 → 0/1). */
function bpsToFee(bps: number): { num: bigint; den: bigint } {
  const n = BigInt(bps);
  const d = 10_000n;
  const g = gcd(n, d) || 1n;
  return { num: n / g, den: d / g };
}

export default function CreatePoolPage() {
  const { connected, wallet } = useWallet();
  const assets = useAssets();
  const { pools } = usePools();
  // Pool creation spends a script (the mint), so it needs collateral like every write flow.
  const {
    networkReady,
    collateralReady,
    needsCollateral,
    recheckCollateral,
    baseReason,
  } = useWriteGate({ requireCollateral: true });

  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(undefined);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(ADA_TOKEN);
  const [feePct, setFeePct] = useState("0.3");
  const [state, setState] = useState<TxState>({ kind: "idle" });
  // Guard a synchronous double-click: both clicks see canSubmit=true before React
  // re-renders to "busy", which would build + submit two txs spending the SAME seed
  // (the second double-spends → node rejects). The ref blocks the second call instantly.
  const submitting = useRef(false);

  // Token universe: ADA + the wallet's own assets (deduped by unit).
  const tokens = useMemo(() => {
    const byUnit = new Map<string, TokenInfo>([[ADA_TOKEN.unit, ADA_TOKEN]]);
    for (const a of assets ?? []) {
      if (a.unit === "lovelace" || byUnit.has(a.unit)) continue;
      byUnit.set(a.unit, walletTokenInfo(a.unit));
    }
    return [...byUnit.values()];
  }, [assets]);

  // The user enters a plain percentage (0.3 = 0.30%). Under the hood it's stored on-chain
  // as integer basis points (0.3% → 30 bps → fee 3/1000), but we never surface that.
  const pct = feePct.trim();
  const pctNum =
    pct !== "" && pct !== "." && withinDecimals(pct, 2) ? Number(pct) : NaN;
  const validFee = Number.isFinite(pctNum) && pctNum >= 0 && pctNum < 100;
  const bps = validFee ? Math.round(pctNum * 100) : NaN;
  const fee = validFee ? bpsToFee(bps) : null;

  const samePair = !!tokenA && !!tokenB && tokenA.unit === tokenB.unit;

  // A pool for the same pair (either orientation) AND the same fee already exists. Only a
  // non-blocking warning — duplicates are valid (the chain allows them), but usually a
  // mistake, and the existing pool is the better place to add liquidity.
  const duplicate = useMemo(() => {
    if (!tokenA || !tokenB || samePair || !validFee) return undefined;
    return pools.find(
      (p) =>
        p.feeBps === bps &&
        ((p.tokenA.unit === tokenA.unit && p.tokenB.unit === tokenB.unit) ||
          (p.tokenA.unit === tokenB.unit && p.tokenB.unit === tokenA.unit)),
    );
  }, [pools, tokenA, tokenB, samePair, validFee, bps]);
  const canSubmit =
    networkReady &&
    collateralReady &&
    !!tokenA &&
    !!tokenB &&
    !samePair &&
    validFee &&
    // Only from idle/error — disable after a success so a second click can't mint a
    // DUPLICATE pool (same pair/fee, new seed) while the form is still populated.
    // Changing any input resets state to idle (below), which re-enables a fresh create.
    (state.kind === "idle" || state.kind === "error");

  async function submit() {
    if (!canSubmit || !tokenA || !tokenB || !fee || submitting.current) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      // Normalise ADA to asset_b to match the live pool orientation (asset_a = token).
      let assetAUnit = tokenA.unit;
      let assetBUnit = tokenB.unit;
      if (assetAUnit === "lovelace" && assetBUnit !== "lovelace") {
        [assetAUnit, assetBUnit] = [assetBUnit, assetAUnit];
      }
      // Dynamically imported so @meshsdk/core (tx-building + WASM) stays out of the
      // initial bundle — only pulled in when the user actually creates a pool.
      const { createPool } = await import("@/lib/client/tx");
      const res = await createPool(wallet, {
        assetAUnit,
        assetBUnit,
        feeNum: fee.num,
        feeDen: fee.den,
      });
      setState({ kind: "success", hash: res.txHash, poolId: res.poolId });
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  // Common gate label (connect → wrong-network → checking → collateral) comes from the
  // shared hook; this flow appends only its own reasons.
  const label =
    baseReason ??
    (!tokenA || !tokenB
      ? "Select both tokens"
      : samePair
        ? "Tokens must differ"
        : !validFee
          ? "Enter a fee"
          : state.kind === "busy"
            ? "Creating pool…"
            : state.kind === "success"
              ? "Pool created ✓"
              : "Create pool");

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:px-6 sm:py-14">
      <Link
        href="/pools"
        className="mb-4 inline-block text-sm text-muted transition-colors hover:text-accent"
      >
        ← All pools
      </Link>

      <header className="mb-4">
        <h1 className="font-display text-2xl font-extrabold text-ink">Create pool</h1>
        <p className="mt-1 text-sm text-muted">
          Open a new pool for any pair you hold (anyone can). It starts empty, then you
          add the first liquidity right after.
        </p>
        <p className="mt-1 text-xs text-muted">
          Creating an empty pool locks a ~2 ₳ seed (plus network fees). As the creator you
          can close it and reclaim that seed any time, until someone seeds it with
          liquidity, after which it’s permanent.
        </p>
      </header>

      <div className="k-card w-full p-5 sm:p-6">
        <div className="mb-2 px-1 text-xs text-muted">
          {connected
            ? "Tokens to choose from: ADA + the assets held in your wallet."
            : "Connect a wallet to choose tokens. The list is ADA + your held assets."}
        </div>

        <TokenRow
          label="Token A"
          token={tokenA}
          tokens={tokens}
          exclude={tokenB?.unit}
          onSelect={(t) => {
            setTokenA(t);
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
        />

        <div className="my-2 text-center text-muted">/</div>

        <TokenRow
          label="Token B"
          token={tokenB}
          tokens={tokens}
          exclude={tokenA?.unit}
          onSelect={(t) => {
            setTokenB(t);
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
        />

        <div className="k-field mt-3 p-3.5">
          <div className="mb-2 px-1 text-xs text-muted">Trading fee</div>
          <div className="flex items-center gap-3">
            <input
              inputMode="decimal"
              value={feePct}
              placeholder="0.3"
              onChange={(e) => {
                const v = e.target.value;
                if (withinDecimals(v, 2)) {
                  setFeePct(v);
                  if (state.kind !== "idle") setState({ kind: "idle" });
                }
              }}
              className="k-input text-2xl font-extrabold tabular-nums text-ink"
            />
            <span className="k-pill shrink-0 px-2.5 py-1 text-sm font-medium">
              %
            </span>
          </div>
          <div className="mt-1.5 px-1 text-xs text-muted">
            Taken from each trade and paid to liquidity providers. 0.3% is typical.
          </div>
        </div>

        {duplicate && (
          <div className="k-note k-note-warn mt-3 text-xs">
            A {duplicate.tokenA.ticker}/{duplicate.tokenB.ticker} pool at{" "}
            {(duplicate.feeBps / 100).toFixed(2)}% already exists. You can still create
            another, but you may prefer to{" "}
            <Link
              href={`/pools/${encodeURIComponent(duplicate.id)}`}
              className="k-link"
            >
              add liquidity to the existing pool
            </Link>
            .
          </div>
        )}

        {needsCollateral && (
          <CollateralNote onRecheck={recheckCollateral}>
            Creating a pool spends a script, so your wallet needs a collateral UTXO. Set
            one in your wallet, then re-check.
          </CollateralNote>
        )}

        <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />

        {state.kind === "success" && (
          <div className="k-note k-note-success relative mt-3 text-xs">
            <Confetti />
            <div className="relative flex items-center gap-2">
              <Pip size={26} mood="love" />
              <div className="font-bold text-success">Pool created ✓</div>
            </div>
            <p className="mt-1 text-muted">
              Confirming on-chain (~20–40s). Add the first liquidity to start trading. On
              the next screen, hit ↻ Refresh once it’s confirmed (it won’t show in the
              pools list until then).
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <Link
                href={`/pools/${encodeURIComponent(state.poolId)}`}
                className="k-btn-ghost w-full px-3 py-2 text-center text-sm font-semibold"
              >
                Add initial liquidity →
              </Link>
              <a
                href={explorerTxUrl(state.hash)}
                target="_blank"
                rel="noreferrer"
                className="text-center font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-accent"
              >
                {truncate(state.hash, 10, 8)} ↗
              </a>
            </div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="k-note k-note-danger mt-3 text-xs">
            <div className="flex items-center gap-2">
              <Pip size={26} mood="worried" />
              <div className="font-bold">Hmm, that didn’t go through</div>
            </div>
            <div className="mt-1 break-words opacity-90">{state.message}</div>
          </div>
        )}
      </div>

      <PipOverlay show={state.kind === "busy"} title="Creating your pool…" />
    </div>
  );
}

function TokenRow({
  label,
  token,
  tokens,
  exclude,
  onSelect,
}: {
  label: string;
  token: TokenInfo | undefined;
  tokens: TokenInfo[];
  exclude?: string;
  onSelect: (t: TokenInfo) => void;
}) {
  return (
    <div className="k-field flex items-center justify-between p-3.5">
      <span className="px-1 text-xs text-muted">{label}</span>
      <TokenSelect token={token} tokens={tokens} exclude={exclude} onSelect={onSelect} />
    </div>
  );
}

function SubmitButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="k-btn mt-4 w-full py-3.5 text-sm"
    >
      {label}
    </button>
  );
}
