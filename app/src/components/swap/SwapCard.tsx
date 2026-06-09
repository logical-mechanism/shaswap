"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  useAddress,
  useAssets,
  useLovelace,
  useNetwork,
  useWallet,
} from "@/lib/wallet/hooks";
import type { Pool, TokenInfo } from "@/lib/data";
import { APP_CONFIG, explorerTxUrl } from "@/lib/config";
import { orderFunding } from "@/lib/chain/orderFunding";
import { HIGH_FEE_BPS, RECOMMENDED_MIN_TIP } from "@/lib/chain/deployment";
import { isVerifiedPool } from "@/lib/chain/verifiedPools";
import { useTokens } from "@/hooks/useTokens";
import { usePools } from "@/hooks/usePools";
import { useQuote } from "@/hooks/useQuote";
import { recordPost } from "@/lib/client/activity";
import { nowMs } from "@/lib/client/now";
import { toUserMessage } from "@/lib/client/errors";
import {
  formatAda,
  formatPercent,
  formatUnits,
  toBaseUnits,
  truncate,
  withinDecimals,
} from "@/lib/format";
import { toBigInt as toBig } from "@/lib/bigint";
import { Pip } from "@/components/Pip";
import { PipOverlay } from "@/components/PipOverlay";
import { PipCoachmark } from "@/components/PipCoachmark";
import { Confetti } from "@/components/Confetti";
import { TokenSelect } from "./TokenSelect";
import { SlippageSettings } from "./SlippageSettings";

type PostState =
  | { kind: "idle" }
  | { kind: "posting" }
  | { kind: "success"; hash: string }
  | { kind: "error"; message: string };

export function SwapCard() {
  const { connected, wallet, refresh: refreshWallet } = useWallet();
  const networkId = useNetwork();
  const address = useAddress();
  const { tokens, loading: tokensLoading, error: tokensError } = useTokens();
  const { pools, reload: reloadPools } = usePools();
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
  // Default to the solo-batch floor: 0.5 ₳ covers a single-order settlement's tx fee, so the
  // order is always self-funding even if it never batches with others (RECOMMENDED_MIN_TIP).
  const [tip, setTip] = useState<string>("0.5"); // solver tip, in ADA
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
  // The "To" side stays UNSELECTED until the user picks it (the chip reads "Select") —
  // don't auto-pick the first non-ADA token, which surfaced TEST as a misleading default.
  const toToken: TokenInfo | undefined = byUnit.get(toUnit);

  const baseAmountIn =
    fromToken && amount ? toBaseUnits(amount, fromToken.decimals) : "";

  const {
    quote,
    loading: quoteLoading,
    error: quoteError,
    reload: reloadQuote,
  } = useQuote(fromToken?.unit, toToken?.unit, baseAmountIn);

  // useQuote debounces (~250ms), so after changing the AMOUNT or pair the PREVIOUS
  // quote can still be in hand. Treat a quote as usable only when it matches the CURRENT
  // pair AND the current input amount — otherwise the order could bind to the wrong pool,
  // or (worse) to a floor computed for a different amount, during the debounce/fetch gap.
  const quoteFresh =
    !!quote &&
    quote.tokenIn.unit === fromToken?.unit &&
    quote.tokenOut.unit === toToken?.unit &&
    quote.amountIn === baseAmountIn;

  const toAmount =
    quoteFresh && quote && toToken
      ? formatUnits(quote.amountOut, toToken.decimals)
      : "";

  // The pools that trade this pair (single scan — `pool` and `poolCount` both derive
  // from it). The quote auto-picks the best-priced one.
  const pairPools = useMemo(() => {
    if (!fromToken || !toToken) return [];
    return pools.filter(
      (p) =>
        (p.tokenA.unit === fromToken.unit && p.tokenB.unit === toToken.unit) ||
        (p.tokenA.unit === toToken.unit && p.tokenB.unit === fromToken.unit),
    );
  }, [pools, fromToken, toToken]);
  const poolCount = pairPools.length;

  // The pool that trades this pair (also identifies the order's pool_nft binding).
  // Bind to the SAME pool the FRESH quote was priced against (quote.poolId) so the
  // floor and the order's pool_nft can never reference two different same-pair pools;
  // fall back to the first pair match before/until a matching quote has loaded.
  const pool: Pool | undefined = useMemo(() => {
    if (!fromToken || !toToken) return undefined;
    const byQuote =
      quote &&
      quote.tokenIn.unit === fromToken.unit &&
      quote.tokenOut.unit === toToken.unit &&
      quote.poolId
        ? pairPools.find((p) => p.id === quote.poolId)
        : undefined;
    return byQuote ?? pairPools[0];
  }, [pairPools, fromToken, toToken, quote]);

  // Per-order floor (limit): the worst output the user will accept = the estimated
  // output minus slippage. Post-Rev-25 the limit is an ABORT condition, not the execution
  // price: the pool's two-sided price pin makes the batch settle at the fair AMM-curve
  // price (§5.2.5/§5.2.7), so the user receives ~estOut; the floor only aborts the order if
  // the fair price drifts below it before settlement. The solver can never settle below it.
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
  // Advisory (not blocking): a positive-but-low tip may still be skipped by solvers — a
  // single-order settlement pays the whole tx fee. Surface a caution, don't disable.
  const tipLow = tipValid && BigInt(tipLovelace || "0") < RECOMMENDED_MIN_TIP;

  // Pool trust cues for the selected pool (display-only; not trust-critical to settlement,
  // which is enforced on-chain). A high fee on an immutable, permissionlessly-created pool
  // warrants a heads-up; a verified pool gets a positive badge.
  const feeHigh = pool?.feeBps !== undefined && pool.feeBps >= HIGH_FEE_BPS;
  const poolVerified = isVerifiedPool(pool?.id);

  // Wallet balance of the FROM token (ADA via useLovelace; other tokens via useAssets).
  // The spendable amount + the funding blockers (over-balance / over-spendable / not-enough
  // -ADA) are derived by the pure `orderFunding` helper, which handles ADA's three roles
  // (traded side, min-ADA, tip) and the partial 2× min-ADA. Plain render computation (the
  // React Compiler memoizes); the helper is connectivity-agnostic, so AND each with `connected`.
  const fromBalance =
    fromToken?.unit === "lovelace"
      ? toBig(lovelace ?? "0")
      : toBig(assets?.find((a) => a.unit === fromToken?.unit)?.quantity ?? "0");
  // Wallet balance of the TO token too, so the user sees how much they already hold of what
  // they're buying (display-only — same source as the FROM balance, no funding role).
  const toBalance =
    toToken?.unit === "lovelace"
      ? toBig(lovelace ?? "0")
      : toBig(assets?.find((a) => a.unit === toToken?.unit)?.quantity ?? "0");
  const fromIsAda = fromToken?.unit === "lovelace";
  const amountBig = hasAmount ? BigInt(baseAmountIn) : 0n;
  const funding = orderFunding({
    fromIsAda,
    fromBalance,
    lovelace: toBig(lovelace ?? "0"),
    partial,
    tip: BigInt(tipLovelace || "0"),
    amount: amountBig,
  });
  const overBalance = connected && funding.overBalance;
  const overSpendable = connected && funding.overSpendable;
  const insufficientAda = connected && funding.insufficientAda;
  const balanceOk = !overBalance && !overSpendable;

  // The quote read failed (provider blip) and we have no usable fresh quote to post.
  const quoteFailed = !!quoteError && hasAmount && !!pool && !quoteFresh;

  // No pool trades the selected pair (and pools have loaded) — show a friendly Pip empty
  // state, not just a disabled button. Display-only (token tickers); not trust-critical.
  const noPoolForPair =
    !!fromToken &&
    !!toToken &&
    fromToken.unit !== toToken.unit &&
    pools.length > 0 &&
    poolCount === 0;

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
    // Nothing to flip until both sides are chosen — and flipping a half-empty pair would
    // leave "From" unselected (or duplicate ADA on both sides).
    if (!fromToken || !toToken) return;
    setFromUnit(toToken.unit);
    setToUnit(fromToken.unit);
    setAmount("");
    setPost({ kind: "idle" });
  }

  // Re-scan pool reserves + re-quote on demand. The price is a live estimate as you type
  // (computed from cached reserves), and this pulls the freshest reserves on request —
  // there is NO background polling (see documentation/app-data-caching.md).
  function refreshPrice() {
    reloadPools();
    reloadQuote();
  }

  async function handlePost() {
    if (!canPost || submitting.current || !pool || !fromToken || !toToken) return;
    submitting.current = true;
    setPost({ kind: "posting" });
    try {
      // Dynamically imported so @meshsdk/core (MeshTxBuilder + WASM serialization) stays
      // out of the initial bundle — it's only needed once the user actually posts.
      const { postOrder } = await import("@/lib/client/tx");
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
      // The order moved funds out of the wallet — re-read the balance now (no polling).
      refreshWallet();
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
        : !toToken
          ? { label: "Select a token", disabled: true }
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
              ? { label: "No price right now", disabled: true }
            : !quoteFresh || quoteLoading
              ? { label: "Pip’s pricing it…", disabled: true }
              : floor <= 0n
                ? { label: "Amount too small", disabled: true }
                : !tipValid
                  ? { label: "Enter a solver tip", disabled: true }
                  : post.kind === "posting"
                    ? { label: "Posting order…", disabled: true }
                    : { label: "Post order", disabled: false };

  return (
    <div className="k-card k-glow w-full max-w-md p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-2 px-1">
        <div>
          <div className="flex items-center gap-2">
            <Pip size={30} mood="happy" />
            <h1 className="font-display text-xl font-extrabold text-ink">Swap</h1>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted">
            Drop off an order and the batch settles at one fair price, never below the
            floor you set, or grab it back anytime.
          </p>
        </div>
        <SlippageSettings value={slippage} onChange={setSlippage} context="swap" />
      </div>

      <PipCoachmark id="batch-intro" mood="wave" className="mb-4">
        Heads up: you don’t trade on the spot. You drop off an order, and every little while
        the whole batch settles together at one fair price — so nobody can jump the queue
        ahead of you. Your order rests until then, and it’s always yours to grab back.
      </PipCoachmark>

      {tokensError && (
        <div className="k-note k-note-danger mb-3 text-xs">
          Pip couldn’t load the token list. Check your connection and refresh the page.
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
        decimals={fromToken?.decimals ?? 0}
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
        skeleton={quoteLoading}
        onSelect={(t) => {
          setToUnit(t.unit);
          if (post.kind !== "idle") setPost({ kind: "idle" });
        }}
        balance={
          connected && toToken
            ? { display: formatUnits(toBalance.toString(), toToken.decimals) }
            : undefined
        }
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
        verified={poolVerified}
        tip={tip}
        onRefresh={refreshPrice}
      />

      {/* advanced: tip + partial fills + expiry + the order's ADA breakdown */}
      <Advanced
        open={advanced}
        onToggle={() => setAdvanced((v) => !v)}
        tip={tip}
        onTip={setTip}
        tipValid={tipValid}
        tipLow={tipLow}
        partial={partial}
        onPartial={setPartial}
        expiry={expiry}
        onExpiry={setExpiry}
        orderMinAda={funding.orderMinAda}
        tipLovelace={BigInt(tipLovelace || "0")}
        fromIsAda={fromIsAda}
        tradedAda={fromIsAda ? amountBig : 0n}
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
            size. Consider a smaller amount or expect a worse fill.
          </div>
        )}

      {/* High pool-fee caution — pools are permissionless and immutable, so a steep fee is
          permanent. Verified pools skip the nudge (they're known-good). */}
      {feeHigh && !poolVerified && pool && post.kind !== "posting" && (
        <div className="k-note k-note-warn mt-3 flex items-center gap-2 text-xs">
          <Pip size={22} mood="worried" />
          <span>
            This pool charges a high fee ({((pool.feeBps ?? 0) / 100).toFixed(2)}%). It’s
            not on Pip’s verified list — double-check before you trade.
          </span>
        </div>
      )}

      {quoteFailed && (
        <div className="k-note k-note-danger mt-3 flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-2">
            <Pip size={22} mood="calm" still />
            Pip couldn’t get a price just now. Try again in a sec.
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

      {noPoolForPair && (
        <div className="k-note k-note-info mt-3 flex items-center gap-2 text-xs">
          <Pip size={22} mood="sleepy" />
          <span>
            No pool trades {fromToken?.ticker}/{toToken?.ticker} yet, so Pip can’t route
            this pair. Try another token, or be the first to{" "}
            <Link href="/pools/create" className="k-link">
              open a pool
            </Link>
            .
          </span>
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

      <PipOverlay
        show={post.kind === "posting"}
        title="Tucking your order into the next batch…"
      />
    </div>
  );
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
      <div className="k-note k-note-success relative mt-3 text-xs">
        <Confetti />
        <div className="relative flex items-center gap-2">
          <Pip size={26} mood="cheer" />
          <div className="font-bold text-success">Order posted ✓</div>
        </div>
        <p className="mt-1 text-muted">
          Pip’s tucked it into the next batch. It’ll appear under{" "}
          <a href="/orders" className="k-link">
            Orders
          </a>{" "}
          once the network confirms (~20–40s), resting at your floor until the batch settles —
          or grab it back anytime, which returns your input plus the small ADA deposit and
          tip.
        </p>
        <div className="mt-1.5 flex flex-col items-start gap-1">
          <a href="/orders" className="k-link font-semibold">
            Watch it rest in Orders →
          </a>
          <a
            href={explorerTxUrl(state.hash)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-accent"
          >
            {truncate(state.hash, 10, 8)} ↗
          </a>
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="k-note k-note-danger mt-3 text-xs">
        <div className="flex items-center gap-2">
          <Pip size={26} mood="calm" still />
          <div className="font-bold">Hmm, that didn’t go through</div>
        </div>
        <div className="mt-1 break-words opacity-90">{state.message}</div>
      </div>
    );
  }
  return null;
}

/** Rough, honest guess at the network fee to POST an order — a plain payment to the order
 * address (the validator only runs on settle/reclaim, not on post), so it's a small flat
 * tx fee. Labeled as an estimate in the UI; not used in any funding gate. */
const EST_POST_FEE_LOVELACE = 200_000n;

function Advanced({
  open,
  onToggle,
  tip,
  onTip,
  tipValid,
  tipLow,
  partial,
  onPartial,
  expiry,
  onExpiry,
  orderMinAda,
  tipLovelace,
  fromIsAda,
  tradedAda,
}: {
  open: boolean;
  onToggle: () => void;
  tip: string;
  onTip: (v: string) => void;
  tipValid: boolean;
  /** Tip is positive but below the recommended floor — advisory caution, not blocking. */
  tipLow: boolean;
  partial: boolean;
  onPartial: (v: boolean) => void;
  expiry: string;
  onExpiry: (v: string) => void;
  /** Min-ADA the order UTXO must carry (doubled when partial fills are on), in lovelace. */
  orderMinAda: bigint;
  /** The posted solver tip, in lovelace. */
  tipLovelace: bigint;
  /** Selling ADA → the traded lovelace also sits on the order UTXO. */
  fromIsAda: boolean;
  /** ADA being sold (lovelace) when fromIsAda; 0 otherwise. */
  tradedAda: bigint;
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
                the only solver reward. Required: a 0-tip order won’t be picked up.
                Higher tips settle sooner.
              </span>
            </span>
            <input
              inputMode="decimal"
              value={tip}
              onChange={(e) => {
                // Tip is ADA (6 decimals) — mask to its precision like the amount fields.
                const v = e.target.value;
                if (withinDecimals(v, 6)) onTip(v);
              }}
              className={`k-input-box w-24 px-2 py-1.5 text-right tabular-nums ${
                tipValid && !tipLow ? "" : "border-danger"
              }`}
            />
          </label>
          {tipLow && (
            <p className="-mt-1 text-[11px] text-warning">
              That tip is on the low side — a solver may skip it (a small batch pays the
              whole network fee). 0.5 ₳ covers a solo batch; a higher tip settles sooner.
            </p>
          )}
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
                a solver can only settle before this deadline (reclaim anytime); a
                resting order can fill whenever the price reaches your floor
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

          {/* Why the order holds exact ADA — the three roles ADA plays on one UTXO
              (BLUEPRINT §5.2.1), plus a rough fee guess. Short and reassuring; not a gate. */}
          <div className="space-y-1.5 border-t border-border pt-2.5 text-[11px] text-muted">
            <div className="font-semibold text-muted">ADA on your order</div>
            <p className="leading-snug">
              Your order is its own little UTXO, so it carries some ADA in separate roles.
              It all comes back when it settles or you grab it back — only the tip is ever kept.
            </p>
            <DetailRow label="Held min-ADA (UTXO deposit)">
              ~{formatAda(orderMinAda.toString())} ₳
            </DetailRow>
            {partial && (
              <p className="-mt-0.5 text-[10px] leading-snug text-muted">
                Doubled because partial fills can leave a second reclaimable piece.
              </p>
            )}
            <DetailRow label="Solver tip">
              {tipLovelace > 0n ? `${formatAda(tipLovelace.toString())} ₳` : "—"}
            </DetailRow>
            {fromIsAda && tradedAda > 0n && (
              <DetailRow label="ADA you’re selling">
                {formatAda(tradedAda.toString())} ₳
              </DetailRow>
            )}
            <DetailRow label="Est. network fee">
              ~{formatAda(EST_POST_FEE_LOVELACE.toString())} ₳{" "}
              <span className="text-muted/70">(rough guess)</span>
            </DetailRow>
          </div>
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
  decimals = 0,
  loading,
  skeleton,
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
  /** Max fractional digits accepted while typing (the token's precision; 0 if unknown). */
  decimals?: number;
  loading?: boolean;
  /** Show the "Pip’s thinking" dots in place of the value (the To field, mid-quote). */
  skeleton?: boolean;
  placeholder?: string;
  onAmount?: (v: string) => void;
  onSelect: (t: TokenInfo) => void;
  balance?: {
    display: string;
    insufficient?: boolean;
  };
}) {
  return (
    <div className="k-field p-3.5">
      <div className="mb-2 px-1 text-xs font-semibold text-muted">{label}</div>
      <div className="flex items-center gap-3">
        {skeleton ? (
          // Pip works out the estimate: a little bouncing-dots "thinking" indicator in
          // place of the value — reads as intentional, instead of the old empty bordered
          // box that looked like a second, broken input.
          <div className="flex h-9 flex-1 items-center gap-2">
            <Pip size={24} mood="thinking" />
            <span className="flex items-center gap-1" aria-hidden>
              <span className="h-2 w-2 animate-bounce rounded-full bg-accent/60 [animation-delay:-0.32s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-accent/60 [animation-delay:-0.16s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-accent/60" />
            </span>
            <span className="sr-only">Pip’s working out your estimate…</span>
          </div>
        ) : (
          <input
            inputMode="decimal"
            value={amount}
            readOnly={!editable}
            placeholder={placeholder}
            onChange={(e) => {
              const v = e.target.value;
              if (withinDecimals(v, decimals)) onAmount?.(v);
            }}
            className={`k-input text-3xl font-extrabold tabular-nums ${
              editable ? "text-ink" : "text-muted"
            }`}
          />
        )}
        <TokenSelect
          token={token}
          tokens={tokens}
          exclude={exclude}
          onSelect={onSelect}
        />
      </div>
      {balance && (
        <div className="mt-2 px-1 text-[11px]">
          <span className={balance.insufficient ? "font-semibold text-danger" : "text-muted"}>
            Balance:{" "}
            <span className="tabular-nums">{balance.display}</span> {token?.ticker}
          </span>
        </div>
      )}
      {loading && <div className="mt-1 px-1 text-xs text-muted">Pip’s refreshing…</div>}
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
  verified,
  tip,
  onRefresh,
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
  /** Pool is on the verified allowlist — a positive trust badge (display-only). */
  verified: boolean;
  tip: string;
  /** Re-scan reserves + re-quote on demand (no background polling). */
  onRefresh: () => void;
}) {
  // `price` is the pool MID price in HUMAN units (tokenOut per tokenIn, decimal-adjusted)
  // — it ignores the fee and price impact, so the rate shown is the mid price while the
  // "To" amount / Minimum received reflect the actual (post-fee) execution. Collapsed by
  // default: the rate is the at-a-glance summary; the full breakdown expands.
  const [open, setOpen] = useState(false);
  const priceNum = price ? Number(price) : 0;
  const showRate = !!price && !!fromToken && !!toToken && priceNum > 0;
  const tipNum = Number(tip);
  // Big rates want grouped thousands; a sub-1 rate (e.g. selling a low-decimal token for
  // ADA) wants significant digits so a tiny-but-real price doesn't round to "0".
  const priceText =
    priceNum >= 1
      ? priceNum.toLocaleString(undefined, { maximumFractionDigits: 6 })
      : priceNum.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  const rateText =
    loading && !showRate
      ? "Pip’s checking the rate…"
      : showRate
        ? `1 ${fromToken.ticker} ≈ ${priceText} ${toToken.ticker}`
        : "Pop in an amount and Pip will price it.";

  return (
    <div className="k-field mt-3 text-xs text-muted">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center justify-between gap-2 px-3 py-2.5 text-left"
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
        {/* On-demand price refresh — re-scans reserves + re-quotes (no background poll). */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh price"
          title="Refresh price"
          className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-accent disabled:opacity-50"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            className={loading ? "animate-spin" : ""}
            aria-hidden
          >
            <path
              d="M13.5 8a5.5 5.5 0 10-1.6 3.9M13.5 12.5V9h-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {open && (
        <div className="animate-pop space-y-1.5 border-t border-border px-3 pb-3 pt-2.5">
          <DetailRow label="Price impact">
            {loading || priceImpact === undefined ? "—" : formatPercent(priceImpact)}
          </DetailRow>
          <DetailRow label="Pool fee">
            {feeBps !== undefined ? `${(feeBps / 100).toFixed(2)}%` : "—"}
          </DetailRow>
          {verified && (
            <DetailRow label="Pool">
              <span className="font-semibold text-success">✓ Verified</span>
            </DetailRow>
          )}
          <DetailRow label="Solver tip">
            {Number.isFinite(tipNum) && tipNum > 0 ? `${tip} ADA` : "—"}
          </DetailRow>
          <DetailRow label="Max slippage">{slippage.toFixed(1)}%</DetailRow>
          <div className="flex items-center justify-between font-bold text-ink">
            <span>
              Your floor{" "}
              <span className="font-normal text-muted">(min. received)</span>
            </span>
            <span className="tabular-nums">
              {floorDisplay && toToken ? `${floorDisplay} ${toToken.ticker}` : "—"}
            </span>
          </div>
          {poolCount > 1 && (
            <DetailRow label="Pool">best of {poolCount} pools</DetailRow>
          )}
          <p className="pt-1 text-[11px] leading-snug text-muted">
            Settles at the pool’s fair price — the on-chain pin makes the batch clear at
            the AMM curve, never worse. Max slippage is a safety abort: if the fair price
            drifts below it before your order settles, the order rests instead of filling
            worse.
          </p>
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
