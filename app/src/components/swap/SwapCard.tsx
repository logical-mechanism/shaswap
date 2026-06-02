"use client";

import { useMemo, useState } from "react";
import { useNetwork, useWallet } from "@meshsdk/react";
import type { Pool, TokenInfo } from "@/lib/data";
import { APP_CONFIG, explorerTxUrl } from "@/lib/config";
import { useTokens } from "@/hooks/useTokens";
import { usePools } from "@/hooks/usePools";
import { useQuote } from "@/hooks/useQuote";
import { postOrder } from "@/lib/client/tx";
import { recordPost } from "@/lib/client/activity";
import { toUserMessage } from "@/lib/client/errors";
import { formatPercent, formatUnits, toBaseUnits, truncate } from "@/lib/format";
import { TokenSelect } from "./TokenSelect";
import { SlippageSettings } from "./SlippageSettings";

type PostState =
  | { kind: "idle" }
  | { kind: "posting" }
  | { kind: "success"; hash: string }
  | { kind: "error"; message: string };

export function SwapCard() {
  const { connected, wallet } = useWallet();
  const networkId = useNetwork();
  const { tokens, loading: tokensLoading } = useTokens();
  const { pools } = usePools();

  const [fromUnit, setFromUnit] = useState<string>("lovelace");
  const [toUnit, setToUnit] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [slippage, setSlippage] = useState<number>(0.5);
  const [tip, setTip] = useState<string>("2"); // solver tip, in ADA
  const [partial, setPartial] = useState<boolean>(false);
  const [expiry, setExpiry] = useState<string>("none"); // none|1h|6h|1d|1w
  const [advanced, setAdvanced] = useState<boolean>(false);
  const [post, setPost] = useState<PostState>({ kind: "idle" });

  // Resolve token objects once the list loads; pick sensible defaults.
  const byUnit = useMemo(
    () => new Map(tokens.map((t) => [t.unit, t])),
    [tokens],
  );
  const fromToken: TokenInfo | undefined = byUnit.get(fromUnit) ?? tokens[0];
  const toToken: TokenInfo | undefined =
    byUnit.get(toUnit) ?? tokens.find((t) => t.unit !== fromToken?.unit);

  const baseAmountIn =
    fromToken && amount ? toBaseUnits(amount, fromToken.decimals) : "";

  const { quote, loading: quoteLoading } = useQuote(
    fromToken?.unit,
    toToken?.unit,
    baseAmountIn,
  );

  const toAmount =
    quote && toToken ? formatUnits(quote.amountOut, toToken.decimals) : "";

  // The pool that trades this pair (also identifies the order's pool_nft binding).
  // Bind to the SAME pool the quote was priced against (quote.poolId) so the floor
  // and the order's pool_nft can never reference two different same-pair pools;
  // fall back to a pair match before any quote has loaded.
  const pool: Pool | undefined = useMemo(() => {
    if (!fromToken || !toToken) return undefined;
    const byQuote = quote?.poolId
      ? pools.find((p) => p.id === quote.poolId)
      : undefined;
    return (
      byQuote ??
      pools.find(
        (p) =>
          (p.tokenA.unit === fromToken.unit && p.tokenB.unit === toToken.unit) ||
          (p.tokenA.unit === toToken.unit && p.tokenB.unit === fromToken.unit),
      )
    );
  }, [pools, fromToken, toToken, quote]);

  // How many pools trade this pair (the quote auto-picks the best-priced one).
  const poolCount = useMemo(() => {
    if (!fromToken || !toToken) return 0;
    return pools.filter(
      (p) =>
        (p.tokenA.unit === fromToken.unit && p.tokenB.unit === toToken.unit) ||
        (p.tokenA.unit === toToken.unit && p.tokenB.unit === fromToken.unit),
    ).length;
  }, [pools, fromToken, toToken]);

  // Per-order floor (limit): the worst output the user will accept = the estimated
  // output minus slippage. The solver may NEVER settle below this (§5.2.5).
  const slippageBps = BigInt(Math.round(slippage * 100));
  const estOut = quote ? toBig(quote.amountOut) : 0n;
  const floor = estOut > 0n ? (estOut * (10_000n - slippageBps)) / 10_000n : 0n;
  const floorDisplay =
    toToken && floor > 0n ? formatUnits(floor.toString(), toToken.decimals) : "";

  const hasAmount =
    !!baseAmountIn && /^[0-9]+$/.test(baseAmountIn) && BigInt(baseAmountIn) > 0n;
  const wrongNetwork =
    connected && networkId !== undefined && networkId !== APP_CONFIG.networkId;
  // Fail CLOSED: only allow posting once the wallet's network is KNOWN and correct
  // (networkId is undefined for a beat after connect — don't post a preprod order
  // through a wallet whose network we haven't confirmed yet).
  const networkReady = connected && networkId === APP_CONFIG.networkId;
  const tipLovelace = toBaseUnits(tip || "0", 6);
  const tipValid = tipLovelace !== "" && BigInt(tipLovelace || "0") >= 0n;

  const canPost =
    networkReady &&
    hasAmount &&
    !!pool &&
    !!quote &&
    floor > 0n &&
    tipValid &&
    post.kind !== "posting";

  function flip() {
    const f = fromToken?.unit ?? "";
    const t = toToken?.unit ?? "";
    setFromUnit(t);
    setToUnit(f);
    setAmount("");
    setPost({ kind: "idle" });
  }

  async function handlePost() {
    if (!canPost || !pool || !fromToken || !toToken) return;
    setPost({ kind: "posting" });
    try {
      const res = await postOrder(wallet, {
        pool,
        sellUnit: fromToken.unit,
        sellAmount: BigInt(baseAmountIn),
        limit: floor,
        tip: BigInt(tipLovelace || "0"),
        partial,
        deadline: expiryDeadline(expiry),
      });
      // Record locally so it shows as "pending" under Orders until the chain indexes
      // it (Blockfrost only lists live UTXOs).
      recordPost(res.owner, {
        ref: res.orderRef,
        txHash: res.txHash,
        inUnit: fromToken.unit,
        inTicker: fromToken.ticker,
        inDecimals: fromToken.decimals,
        outTicker: toToken.ticker,
        outDecimals: toToken.decimals,
        amountIn: baseAmountIn,
        minOut: floor.toString(),
        partial,
        ts: Date.now(),
      });
      setPost({ kind: "success", hash: res.txHash });
      setAmount("");
    } catch (e) {
      setPost({ kind: "error", message: toUserMessage(e) });
    }
  }

  const button = !connected
    ? { label: "Connect wallet", disabled: true }
    : wrongNetwork
      ? { label: "Wrong network", disabled: true }
      : !networkReady
        ? { label: "Checking network…", disabled: true }
        : !hasAmount
          ? { label: "Enter an amount", disabled: true }
          : !pool
            ? { label: "No pool for this pair", disabled: true }
            : !quote || quoteLoading
              ? { label: "Fetching quote…", disabled: true }
              : floor <= 0n
                ? { label: "Amount too small", disabled: true }
                : !tipValid
                  ? { label: "Enter a valid tip", disabled: true }
                  : post.kind === "posting"
                    ? { label: "Posting order…", disabled: true }
                    : { label: "Post order", disabled: false };

  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-surface/80 p-4 shadow-2xl backdrop-blur-sm sm:p-5">
      <div className="mb-3 flex items-center justify-between px-1">
        <h1 className="text-base font-semibold">Swap</h1>
        <SlippageSettings value={slippage} onChange={setSlippage} />
      </div>

      {/* FROM */}
      <TokenField
        label="From"
        token={fromToken}
        tokens={tokens}
        exclude={toToken?.unit}
        amount={amount}
        editable
        loading={tokensLoading}
        onAmount={(v) => {
          setAmount(v);
          if (post.kind !== "idle") setPost({ kind: "idle" });
        }}
        onSelect={(t) => setFromUnit(t.unit)}
      />

      {/* direction toggle */}
      <div className="relative z-10 -my-2 flex justify-center">
        <button
          type="button"
          onClick={flip}
          aria-label="Swap direction"
          className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-surface text-muted transition-colors hover:text-accent"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M4.5 2.5v9m0 0L2 9m2.5 2.5L7 9M11.5 13.5v-9m0 0L9 7m2.5-2.5L14 7"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* TO */}
      <TokenField
        label="To (estimated)"
        token={toToken}
        tokens={tokens}
        exclude={fromToken?.unit}
        amount={toAmount}
        editable={false}
        loading={quoteLoading}
        placeholder={quoteLoading ? "…" : "0"}
        onSelect={(t) => setToUnit(t.unit)}
      />

      {/* rate / price impact / floor */}
      <RateLine
        fromToken={fromToken}
        toToken={toToken}
        price={quote?.price}
        priceImpact={quote?.priceImpact}
        loading={quoteLoading}
        slippage={slippage}
        floorDisplay={floorDisplay}
        poolCount={poolCount}
      />

      {/* advanced: tip + partial fills + expiry */}
      <Advanced
        open={advanced}
        onToggle={() => setAdvanced((v) => !v)}
        tip={tip}
        onTip={setTip}
        tipValid={tipValid}
        partial={partial}
        onPartial={setPartial}
        expiry={expiry}
        onExpiry={setExpiry}
      />

      {/* high price-impact caution (the quote is an estimate over real reserves) */}
      {quote &&
        hasAmount &&
        quote.priceImpact >= 0.05 &&
        post.kind !== "posting" && (
          <div
            className={`mt-3 rounded-xl border p-2.5 text-xs ${
              quote.priceImpact >= 0.15
                ? "border-red-500/25 bg-red-500/10 text-red-300"
                : "border-amber-500/20 bg-amber-500/10 text-amber-300"
            }`}
          >
            {quote.priceImpact >= 0.15 ? "Very high" : "High"} price impact (
            {formatPercent(quote.priceImpact)}). This pool is shallow for that
            size — consider a smaller amount or expect a worse fill.
          </div>
        )}

      <button
        type="button"
        disabled={button.disabled}
        onClick={handlePost}
        className="mt-3 w-full rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3.5 text-sm font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:from-white/10 disabled:to-white/10 disabled:text-muted"
      >
        {button.label}
      </button>

      <PostResult state={post} />

      {/* The honest framing: this posts an INTENT; a solver settles it later. */}
      {pool && hasAmount && post.kind === "idle" && (
        <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted/80">
          You post an order (an intent). An untrusted solver settles the batch
          later at a uniform price — never below your floor — or you reclaim it.
        </p>
      )}
    </div>
  );
}

function toBig(s: string): bigint {
  try {
    return BigInt(s.split(".")[0] || "0");
  } catch {
    return 0n;
  }
}

const EXPIRY_MS: Record<string, number> = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** Selected expiry → an absolute POSIX-ms deadline for the OrderDatum, or null. */
function expiryDeadline(key: string): bigint | null {
  const ms = EXPIRY_MS[key];
  return ms ? BigInt(Date.now() + ms) : null;
}

function PostResult({ state }: { state: PostState }) {
  if (state.kind === "success") {
    return (
      <div className="mt-3 rounded-xl border border-accent/20 bg-accent/10 p-3 text-xs">
        <div className="font-medium text-accent">Order posted ✓</div>
        <p className="mt-0.5 text-muted">
          It’ll appear under{" "}
          <a href="/orders" className="underline underline-offset-2 hover:text-accent">
            Orders
          </a>{" "}
          once the network confirms (~20–40s), where you can reclaim it.
        </p>
        <a
          href={explorerTxUrl(state.hash)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          {truncate(state.hash, 10, 8)} ↗
        </a>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
        <div className="font-medium">Could not post order</div>
        <div className="mt-1 break-words text-red-300/80">{state.message}</div>
      </div>
    );
  }
  return null;
}

function Advanced({
  open,
  onToggle,
  tip,
  onTip,
  tipValid,
  partial,
  onPartial,
  expiry,
  onExpiry,
}: {
  open: boolean;
  onToggle: () => void;
  tip: string;
  onTip: (v: string) => void;
  tipValid: boolean;
  partial: boolean;
  onPartial: (v: boolean) => void;
  expiry: string;
  onExpiry: (v: string) => void;
}) {
  return (
    <div className="mt-3 border-t border-white/5 pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-1 text-xs text-muted hover:text-foreground"
      >
        <span>Advanced</span>
        <span className="text-muted/70">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3 px-1">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted">
              Solver tip (ADA)
              <span className="block text-[10px] text-muted/60">
                the only solver reward — higher tips settle sooner
              </span>
            </span>
            <input
              inputMode="decimal"
              value={tip}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d*\.?\d*$/.test(v)) onTip(v);
              }}
              className={`w-24 rounded-lg border bg-black/20 px-2 py-1.5 text-right tabular-nums outline-none ${
                tipValid ? "border-white/10" : "border-red-500/40"
              }`}
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
            <span className="text-muted">
              Allow partial fills
              <span className="block text-[10px] text-muted/60">
                a solver may fill part now and leave a reclaimable remainder
              </span>
            </span>
            <input
              type="checkbox"
              checked={partial}
              onChange={(e) => onPartial(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted">
              Expiry
              <span className="block text-[10px] text-muted/60">
                a solver can only settle before this deadline (reclaim anytime)
              </span>
            </span>
            <select
              value={expiry}
              onChange={(e) => onExpiry(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs outline-none"
            >
              <option value="none">No expiry</option>
              <option value="1h">1 hour</option>
              <option value="6h">6 hours</option>
              <option value="1d">1 day</option>
              <option value="1w">1 week</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function TokenField({
  label,
  token,
  tokens,
  exclude,
  amount,
  editable,
  loading,
  placeholder = "0",
  onAmount,
  onSelect,
}: {
  label: string;
  token: TokenInfo | undefined;
  tokens: TokenInfo[];
  exclude?: string;
  amount: string;
  editable: boolean;
  loading?: boolean;
  placeholder?: string;
  onAmount?: (v: string) => void;
  onSelect: (t: TokenInfo) => void;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-3">
      <div className="mb-2 px-1 text-xs text-muted">{label}</div>
      <div className="flex items-center gap-3">
        <input
          inputMode="decimal"
          value={amount}
          readOnly={!editable}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*\.?\d*$/.test(v)) onAmount?.(v);
          }}
          className={`w-full bg-transparent text-2xl font-medium outline-none placeholder:text-muted/50 ${
            editable ? "" : "text-muted"
          }`}
        />
        <TokenSelect
          token={token}
          tokens={tokens}
          exclude={exclude}
          onSelect={onSelect}
        />
      </div>
      {loading && <div className="mt-1 px-1 text-xs text-muted">updating…</div>}
    </div>
  );
}

function RateLine({
  fromToken,
  toToken,
  price,
  priceImpact,
  loading,
  slippage,
  floorDisplay,
  poolCount,
}: {
  fromToken: TokenInfo | undefined;
  toToken: TokenInfo | undefined;
  price: string | undefined;
  priceImpact: number | undefined;
  loading?: boolean;
  slippage: number;
  floorDisplay: string;
  poolCount: number;
}) {
  const showRate = price && fromToken && toToken && Number(price) > 0;
  return (
    <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
      <div className="flex items-center justify-between">
        <span>Rate</span>
        <span className="tabular-nums">
          {loading
            ? "…"
            : showRate
              ? `1 ${fromToken.ticker} ≈ ${Number(price).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toToken.ticker}`
              : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span>Price impact</span>
        <span className="tabular-nums">
          {loading || priceImpact === undefined
            ? "—"
            : formatPercent(priceImpact)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span>Max slippage</span>
        <span className="tabular-nums">{slippage.toFixed(1)}%</span>
      </div>
      <div className="flex items-center justify-between font-medium text-foreground/90">
        <span>Floor (min received)</span>
        <span className="tabular-nums">
          {floorDisplay && toToken ? `${floorDisplay} ${toToken.ticker}` : "—"}
        </span>
      </div>
      {poolCount > 1 && (
        <div className="flex items-center justify-between">
          <span>Pool</span>
          <span>best of {poolCount} pools</span>
        </div>
      )}
    </div>
  );
}
