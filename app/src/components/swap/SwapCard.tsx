"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAddress,
  useAssets,
  useLovelace,
  useNetwork,
  useWallet,
} from "@meshsdk/react";
import type { Pool, TokenInfo } from "@/lib/data";
import { APP_CONFIG, explorerTxUrl } from "@/lib/config";
import { useTokens } from "@/hooks/useTokens";
import { usePools } from "@/hooks/usePools";
import { useQuote } from "@/hooks/useQuote";
import { postOrder } from "@/lib/client/tx";
import { recordPost } from "@/lib/client/activity";
import { nowMs } from "@/lib/client/now";
import { toUserMessage } from "@/lib/client/errors";
import {
  formatPercent,
  formatUnits,
  formatUnitsPlain,
  toBaseUnits,
  truncate,
} from "@/lib/format";
import { Pip } from "@/components/Pip";
import { Confetti } from "@/components/Confetti";
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
  const address = useAddress();
  const { tokens, loading: tokensLoading, error: tokensError } = useTokens();
  const { pools } = usePools();
  const lovelace = useLovelace();
  const assets = useAssets();
  // Synchronous re-entry latch: two same-tick clicks both pass `canPost` (the disabled
  // state updates async), which would build two orders from overlapping UTXOs. Mirrors
  // the guard createPool/closePool already use.
  const submitting = useRef(false);

  const [fromUnit, setFromUnit] = useState<string>("lovelace");
  const [toUnit, setToUnit] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [slippage, setSlippage] = useState<number>(0.5);
  const [tip, setTip] = useState<string>("2"); // solver tip, in ADA
  const [partial, setPartial] = useState<boolean>(false);
  const [expiry, setExpiry] = useState<string>("none"); // none|1h|6h|1d|1w
  const [advanced, setAdvanced] = useState<boolean>(false);
  const [post, setPost] = useState<PostState>({ kind: "idle" });

  // Drop a stale "Order posted ✓" (and the spent amount) when the wallet / account
  // changes — a success from a previous identity must not linger over a new one.
  const prevAddress = useRef(address);
  useEffect(() => {
    if (prevAddress.current !== address) {
      prevAddress.current = address;
      setPost({ kind: "idle" });
      setAmount("");
    }
  }, [address]);

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

  const {
    quote,
    loading: quoteLoading,
    error: quoteError,
    reload: reloadQuote,
  } = useQuote(fromToken?.unit, toToken?.unit, baseAmountIn);

  // useQuote debounces (~250ms), so after switching tokens the PREVIOUS pair's quote
  // can still be in hand. Treat a quote as usable only when it matches the CURRENT
  // pair — otherwise the order could bind to the wrong pool with a stale floor.
  const quoteFresh =
    !!quote &&
    quote.tokenIn.unit === fromToken?.unit &&
    quote.tokenOut.unit === toToken?.unit;

  const toAmount =
    quoteFresh && quote && toToken
      ? formatUnits(quote.amountOut, toToken.decimals)
      : "";

  // The pool that trades this pair (also identifies the order's pool_nft binding).
  // Bind to the SAME pool the FRESH quote was priced against (quote.poolId) so the
  // floor and the order's pool_nft can never reference two different same-pair pools;
  // fall back to a pair match before/until a matching quote has loaded.
  const pool: Pool | undefined = useMemo(() => {
    if (!fromToken || !toToken) return undefined;
    const byQuote =
      quote &&
      quote.tokenIn.unit === fromToken.unit &&
      quote.tokenOut.unit === toToken.unit &&
      quote.poolId
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
  const estOut = quoteFresh && quote ? toBig(quote.amountOut) : 0n;
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
  // The tip is the ONLY solver reward — a 0-tip order can never be picked up, so require
  // a positive tip (mirrors the buildOrder guard) rather than post an un-settleable order.
  const tipValid = tipLovelace !== "" && BigInt(tipLovelace || "0") > 0n;

  // Wallet balance of the FROM token (ADA via useLovelace; other tokens via useAssets),
  // and how much of it is actually spendable. For ADA we hold back a reserve for the
  // network fee + the order's min-ADA + the (separate) tip, so MAX can't build an
  // un-submittable tx; for other tokens the whole balance is spendable. Plain render
  // computation (the React Compiler memoizes).
  const fromBalance =
    fromToken?.unit === "lovelace"
      ? toBig(lovelace ?? "0")
      : toBig(assets?.find((a) => a.unit === fromToken?.unit)?.quantity ?? "0");
  const fromIsAda = fromToken?.unit === "lovelace";
  const adaReserve = ADA_RESERVE + (fromIsAda ? BigInt(tipLovelace || "0") : 0n);
  const spendable = fromIsAda
    ? fromBalance > adaReserve
      ? fromBalance - adaReserve
      : 0n
    : fromBalance;
  const amountBig = hasAmount ? BigInt(baseAmountIn) : 0n;
  const overBalance = connected && hasAmount && amountBig > fromBalance;
  const overSpendable =
    connected && hasAmount && !overBalance && amountBig > spendable;
  const balanceOk = !overBalance && !overSpendable;

  // A non-ADA sell still funds the order's min-ADA + tip + network fee from the wallet's
  // lovelace. Verify the wallet holds that ADA up front (the ADA-sell path already
  // reserves it inside `spendable`) instead of failing opaquely at coin selection.
  const adaForOrder = BigInt(tipLovelace || "0") + ADA_RESERVE;
  const insufficientAda =
    connected && !fromIsAda && hasAmount && toBig(lovelace ?? "0") < adaForOrder;

  // The quote read failed (provider blip) and we have no usable fresh quote to post.
  const quoteFailed = !!quoteError && hasAmount && !!pool && !quoteFresh;

  const canPost =
    networkReady &&
    hasAmount &&
    balanceOk &&
    !insufficientAda &&
    !!pool &&
    quoteFresh &&
    !quoteLoading &&
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

  function setFromAmount(base: bigint) {
    if (!fromToken || base <= 0n) return;
    // Plain (non-grouped) so the value round-trips back through toBaseUnits and stays
    // editable — a comma-grouped "1,000" would be rejected and dead-end the button.
    setAmount(formatUnitsPlain(base.toString(), fromToken.decimals));
    if (post.kind !== "idle") setPost({ kind: "idle" });
  }

  async function handlePost() {
    if (!canPost || submitting.current || !pool || !fromToken || !toToken) return;
    submitting.current = true;
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
        ts: nowMs(),
      });
      setPost({ kind: "success", hash: res.txHash });
      setAmount("");
    } catch (e) {
      setPost({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
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
          : overBalance
            ? { label: `Insufficient ${fromToken?.ticker ?? "balance"}`, disabled: true }
            : overSpendable
              ? { label: "Leave ADA for tip + fees", disabled: true }
              : insufficientAda
                ? { label: "Not enough ADA for fees", disabled: true }
              : !pool
                ? { label: "No pool for this pair", disabled: true }
            : quoteFailed
              ? { label: "Quote unavailable", disabled: true }
            : !quoteFresh || quoteLoading
              ? { label: "Fetching quote…", disabled: true }
              : floor <= 0n
                ? { label: "Amount too small", disabled: true }
                : !tipValid
                  ? { label: "Enter a solver tip", disabled: true }
                  : post.kind === "posting"
                    ? { label: "Posting order…", disabled: true }
                    : { label: "Post order", disabled: false };

  return (
    <div className="k-card w-full max-w-md p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-2 px-1">
        <div>
          <div className="flex items-center gap-2">
            <Pip size={30} mood="happy" />
            <h1 className="font-display text-xl font-extrabold text-ink">Swap</h1>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted">
            Drop off an order and the batch settles at one fair price — never below the
            floor you set, or grab it back anytime.
          </p>
        </div>
        <SlippageSettings value={slippage} onChange={setSlippage} context="swap" />
      </div>

      {tokensError && (
        <div className="k-note k-note-danger mb-3 text-xs">
          Pip couldn’t load the token list — check your connection and refresh the page.
        </div>
      )}

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
        onSelect={(t) => {
          setFromUnit(t.unit);
          if (post.kind !== "idle") setPost({ kind: "idle" });
        }}
        balance={
          connected && fromToken
            ? {
                display: formatUnits(fromBalance.toString(), fromToken.decimals),
                insufficient: overBalance || overSpendable,
                onHalf: () => setFromAmount(spendable / 2n),
                onMax: () => setFromAmount(spendable),
              }
            : undefined
        }
      />

      {/* direction toggle */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={flip}
          aria-label="Swap direction"
          className="grid h-11 w-11 place-items-center rounded-full border border-border bg-surface text-accent shadow-[0_8px_18px_-10px_rgba(232,69,143,0.55)] transition-transform duration-300 hover:rotate-180 hover:text-accent-2"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M4.5 2.5v9m0 0L2 9m2.5 2.5L7 9M11.5 13.5v-9m0 0L9 7m2.5-2.5L14 7"
              stroke="currentColor"
              strokeWidth="1.6"
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
        onSelect={(t) => {
          setToUnit(t.unit);
          if (post.kind !== "idle") setPost({ kind: "idle" });
        }}
      />

      {/* mid price / impact / pool fee / tip / minimum received */}
      <RateLine
        fromToken={fromToken}
        toToken={toToken}
        price={quoteFresh ? quote?.price : undefined}
        priceImpact={quoteFresh ? quote?.priceImpact : undefined}
        loading={quoteLoading}
        slippage={slippage}
        floorDisplay={floorDisplay}
        poolCount={poolCount}
        feeBps={pool?.feeBps}
        tip={tip}
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
      {quoteFresh &&
        quote &&
        hasAmount &&
        quote.priceImpact >= 0.05 &&
        post.kind !== "posting" && (
          <div
            className={`mt-3 text-xs ${
              quote.priceImpact >= 0.15 ? "k-note k-note-danger" : "k-note k-note-warn"
            }`}
          >
            {quote.priceImpact >= 0.15 ? "Very high" : "High"} price impact (
            {formatPercent(quote.priceImpact)}). This pool is shallow for that
            size — consider a smaller amount or expect a worse fill.
          </div>
        )}

      {quoteFailed && (
        <div className="k-note k-note-danger mt-3 flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-2">
            <Pip size={22} mood="worried" />
            Couldn’t fetch a quote just now.
          </span>
          <button
            type="button"
            onClick={reloadQuote}
            className="k-btn-danger-soft shrink-0 px-3 py-1 text-xs"
          >
            Try again
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={button.disabled}
        onClick={handlePost}
        className="k-btn mt-4 w-full py-3.5 text-sm"
      >
        {button.label}
      </button>

      {/* Announce the live estimate / minimum received to screen readers (the To field
          is read-only, so its updates are otherwise silent). */}
      <p aria-live="polite" className="sr-only">
        {quoteFresh && toToken && toAmount
          ? `Estimated ${toAmount} ${toToken.ticker}; minimum received ${floorDisplay} ${toToken.ticker}.`
          : ""}
      </p>

      <PostResult state={post} />
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

// ADA held back when the FROM token is ADA, so a MAX swap still leaves room for the
// network fee + the order's min-ADA (the tip is added on top of this). ~3 ₳.
const ADA_RESERVE = 3_000_000n;

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
      <div className="k-note k-note-success relative mt-3 text-xs">
        <Confetti />
        <div className="relative flex items-center gap-2">
          <Pip size={26} mood="love" />
          <div className="font-bold text-success">Order posted ✓</div>
        </div>
        <p className="mt-1 text-muted">
          It’ll appear under{" "}
          <a href="/orders" className="k-link">
            Orders
          </a>{" "}
          once the network confirms (~20–40s). From there the batch settles at one fair
          price (never below your floor) — or you can grab it back anytime, which returns
          your input plus the small ADA deposit and tip.
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
      <div className="k-note k-note-danger mt-3 text-xs">
        <div className="flex items-center gap-2">
          <Pip size={26} mood="worried" />
          <div className="font-bold">Hmm, that didn’t go through</div>
        </div>
        <div className="mt-1 break-words opacity-90">{state.message}</div>
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
    <div className="mt-3 border-t border-border pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-1 text-xs font-semibold text-muted transition-colors hover:text-accent"
      >
        <span>Advanced</span>
        <span className="text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3 px-1">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted">
              Solver tip (ADA)
              <span className="block text-[11px] text-muted">
                the only solver reward — required; a 0-tip order won’t be picked up.
                Higher tips settle sooner.
              </span>
            </span>
            <input
              inputMode="decimal"
              value={tip}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d*\.?\d*$/.test(v)) onTip(v);
              }}
              className={`k-input-box w-24 px-2 py-1.5 text-right tabular-nums ${
                tipValid ? "" : "border-danger"
              }`}
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
            <span className="text-muted">
              Allow partial fills
              <span className="block text-[11px] text-muted">
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
              <span className="block text-[11px] text-muted">
                a solver can only settle before this deadline (reclaim anytime)
              </span>
            </span>
            <select
              value={expiry}
              onChange={(e) => onExpiry(e.target.value)}
              className="k-input-box px-2 py-1.5 text-xs"
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
  balance,
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
  balance?: {
    display: string;
    insufficient?: boolean;
    onMax: () => void;
    onHalf: () => void;
  };
}) {
  return (
    <div className="k-field p-3.5">
      <div className="mb-2 px-1 text-xs font-semibold text-muted">{label}</div>
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
          className={`k-input text-3xl font-extrabold tabular-nums ${
            editable ? "text-ink" : "text-muted"
          }`}
        />
        <TokenSelect
          token={token}
          tokens={tokens}
          exclude={exclude}
          onSelect={onSelect}
        />
      </div>
      {balance && (
        <div className="mt-2 flex items-center justify-between px-1 text-[11px]">
          <span className={balance.insufficient ? "font-semibold text-danger" : "text-muted"}>
            Balance:{" "}
            <span className="tabular-nums">{balance.display}</span> {token?.ticker}
          </span>
          <span className="flex gap-1">
            <button
              type="button"
              onClick={balance.onHalf}
              className="rounded-full border border-border px-3 py-1.5 text-[11px] font-bold text-accent transition-colors hover:bg-accent/12"
            >
              Half
            </button>
            <button
              type="button"
              onClick={balance.onMax}
              className="rounded-full border border-border px-3 py-1.5 text-[11px] font-bold text-accent transition-colors hover:bg-accent/12"
            >
              Max
            </button>
          </span>
        </div>
      )}
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
  feeBps,
  tip,
}: {
  fromToken: TokenInfo | undefined;
  toToken: TokenInfo | undefined;
  price: string | undefined;
  priceImpact: number | undefined;
  loading?: boolean;
  slippage: number;
  floorDisplay: string;
  poolCount: number;
  feeBps: number | undefined;
  tip: string;
}) {
  // `price` is the pool MID price (reserveOut/reserveIn) — it ignores the fee and
  // price impact, so the rate shown is the mid price and the "To" amount / Minimum
  // received reflect the actual (post-fee) execution. Collapsed by default: the rate
  // is the at-a-glance summary; the full breakdown (incl. Minimum received) expands.
  const [open, setOpen] = useState(false);
  const showRate = price && fromToken && toToken && Number(price) > 0;
  const tipNum = Number(tip);
  const rateText =
    loading && !showRate
      ? "Fetching rate…"
      : showRate
        ? `1 ${fromToken.ticker} ≈ ${Number(price).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toToken.ticker}`
        : "Rate appears once you enter an amount";

  return (
    <div className="k-field mt-3 text-xs text-muted">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="truncate font-semibold tabular-nums text-foreground">
          {rateText}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-semibold text-muted">
          <span>Details</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path
              d="M2.5 4.5L6 8l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && (
        <div className="animate-pop space-y-1.5 border-t border-border px-3 pb-3 pt-2.5">
          <DetailRow label="Price impact">
            {loading || priceImpact === undefined ? "—" : formatPercent(priceImpact)}
          </DetailRow>
          <DetailRow label="Pool fee">
            {feeBps !== undefined ? `${(feeBps / 100).toFixed(2)}%` : "—"}
          </DetailRow>
          <DetailRow label="Solver tip">
            {Number.isFinite(tipNum) && tipNum > 0 ? `${tip} ADA` : "—"}
          </DetailRow>
          <DetailRow label="Max slippage">{slippage.toFixed(1)}%</DetailRow>
          <div className="flex items-center justify-between font-bold text-ink">
            <span>Minimum received</span>
            <span className="tabular-nums">
              {floorDisplay && toToken ? `${floorDisplay} ${toToken.ticker}` : "—"}
            </span>
          </div>
          {poolCount > 1 && (
            <DetailRow label="Pool">best of {poolCount} pools</DetailRow>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}
