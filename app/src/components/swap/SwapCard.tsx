"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@meshsdk/react";
import type { TokenInfo } from "@/lib/data";
import { useTokens } from "@/hooks/useTokens";
import { useQuote } from "@/hooks/useQuote";
import { formatPercent, formatUnits, toBaseUnits } from "@/lib/format";
import { TokenSelect } from "./TokenSelect";
import { SlippageSettings } from "./SlippageSettings";

export function SwapCard() {
  const { connected } = useWallet();
  const { tokens, loading: tokensLoading } = useTokens();

  const [fromUnit, setFromUnit] = useState<string>("lovelace");
  const [toUnit, setToUnit] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [slippage, setSlippage] = useState<number>(0.5); // visual only

  // Resolve token objects once the list loads; pick sensible defaults.
  const byUnit = useMemo(
    () => new Map(tokens.map((t) => [t.unit, t])),
    [tokens],
  );
  const fromToken: TokenInfo | undefined =
    byUnit.get(fromUnit) ?? tokens[0];
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

  function flip() {
    const f = fromToken?.unit ?? "";
    const t = toToken?.unit ?? "";
    setFromUnit(t);
    setToUnit(f);
    setAmount("");
  }

  const hasAmount = !!baseAmountIn && /^[0-9]+$/.test(baseAmountIn) &&
    BigInt(baseAmountIn) > 0n;

  // Primary button reflects wallet + input state. It NEVER builds/submits.
  const button = !connected
    ? { label: "Connect wallet", disabled: true }
    : !hasAmount
      ? { label: "Enter an amount", disabled: true }
      : { label: "Swap (coming soon)", disabled: true };

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
        onAmount={setAmount}
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
        label="To"
        token={toToken}
        tokens={tokens}
        exclude={fromToken?.unit}
        amount={toAmount}
        editable={false}
        loading={quoteLoading}
        placeholder={quoteLoading ? "…" : "0"}
        onSelect={(t) => setToUnit(t.unit)}
      />

      {/* rate / price impact */}
      <RateLine
        fromToken={fromToken}
        toToken={toToken}
        price={quote?.price}
        priceImpact={quote?.priceImpact}
        loading={quoteLoading}
        slippage={slippage}
      />

      <button
        type="button"
        disabled={button.disabled}
        className="mt-3 w-full rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3.5 text-sm font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:from-white/10 disabled:to-white/10 disabled:text-muted"
      >
        {button.label}
      </button>
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
      {loading && (
        <div className="mt-1 px-1 text-xs text-muted">updating…</div>
      )}
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
}: {
  fromToken: TokenInfo | undefined;
  toToken: TokenInfo | undefined;
  price: string | undefined;
  priceImpact: number | undefined;
  loading?: boolean;
  slippage: number;
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
    </div>
  );
}
