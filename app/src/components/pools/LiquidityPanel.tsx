"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deserializeAddress, type Asset } from "@meshsdk/core";
import { useAddress, useAssets, useLovelace, useWallet } from "@/lib/wallet/hooks";
import type { Pool, ReferencePrice, TokenInfo } from "@/lib/data";
import { explorerTxUrl } from "@/lib/config";
import { usePoolUtxo } from "@/hooks/usePoolUtxo";
import { useWriteGate } from "@/hooks/useWriteGate";
import {
  buildDeposit,
  buildWithdraw,
  lpPositionValue,
  pairDeltaB,
  type PoolStats,
  type PoolView,
} from "@/lib/chain/lp";
import { quoteLpDeposit, quoteLpWithdraw } from "@/lib/chain/lpQuote";
import { fetchReferencePrice } from "@/lib/client/api";
import { toUserMessage } from "@/lib/client/errors";
import {
  LP_INTENTS_LIVE,
  MIN_LIQ,
  RECOMMENDED_MIN_TIP,
} from "@/lib/chain/deployment";
import { recordLpIntent } from "@/lib/client/lpIntentActivity";
import { nowMs } from "@/lib/client/now";
import { formatUnits, toBaseUnits, truncate, withinDecimals } from "@/lib/format";
import { toBigInt as toBig } from "@/lib/bigint";
import { Pip } from "@/components/Pip";
import { PipOverlay } from "@/components/PipOverlay";
import { RefreshIcon } from "@/components/RefreshIcon";
import { Confetti } from "@/components/Confetti";
import { CollateralNote } from "@/components/CollateralNote";
import { SlippageSettings } from "@/components/swap/SlippageSettings";
import { PendingLpIntents } from "./PendingLpIntents";

type Tab = "add" | "remove";
/** LP write mode: batcher-fulfilled intent (default) or the direct, no-trust pool spend. */
type Mode = "intent" | "direct";

type TxState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "success"; hash: string }
  | { kind: "error"; message: string };

/** Wallet balance of an asset unit (base units), read from the connected wallet's holdings.
 * ADA via lovelace; any other token via its assets entry. 0 when absent/disconnected. */
function walletBalanceOf(
  unit: string,
  lovelace: string | undefined,
  assets: Asset[] | undefined,
): bigint {
  if (unit === "lovelace") return toBig(lovelace ?? "0");
  return toBig(assets?.find((a) => a.unit === unit)?.quantity ?? "0");
}

/** Apply a slippage haircut (bps) to a computed amount, flooring. Clamped to [0,100%]. */
function withSlippage(amount: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(slippagePct * 100))));
  return (amount * (10_000n - bps)) / 10_000n;
}

/** Legible price ratio: grouped thousands for ≥1, significant digits for sub-1 (mirrors
 * the swap card's mid-price), so a tiny-but-real opening price never rounds to "0". */
function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1
    ? n.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : n.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

/** A positive number → a plain (ungrouped) decimal string the amount input accepts, trimmed
 * to the token's precision. "" when it isn't a usable positive amount (so a too-small
 * suggestion doesn't pre-fill a misleading "0"). */
function formatAmountForInput(n: number, decimals: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = Math.max(0, Math.min(decimals, 9));
  const s = d > 0 ? n.toFixed(d).replace(/\.?0+$/, "") : Math.round(n).toString();
  return Number(s) > 0 ? s : "";
}

/**
 * First-deposit price helper: a non-binding market reference for the pair (from an external
 * DEX via the data seam), shown so the creator can open the pool near fair value. When the
 * first amount is entered, offers a one-tap "match market" that fills the paired amount.
 * Renders nothing when there's no reference (testnet / unlisted token / source down) — the
 * form still works, the creator just sets the price by hand.
 */
function FirstDepositReference({
  tokenA,
  tokenB,
  amountA,
  onUse,
}: {
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  amountA: string;
  onUse: (humanB: string) => void;
}) {
  const [ref, setRef] = useState<ReferencePrice | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    // Deferred state writes (the project's effect convention — no sync setState in an effect).
    const id = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      fetchReferencePrice(tokenA.unit, tokenB.unit, ac.signal)
        .then((r) => {
          if (!ac.signal.aborted) setRef(r);
        })
        .catch(() => {
          if (!ac.signal.aborted) setRef(null);
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
      ac.abort();
    };
  }, [tokenA.unit, tokenB.unit]);

  if (loading && !ref) {
    return (
      <p className="px-1 text-[11px] text-muted">Pip’s checking the market price…</p>
    );
  }
  if (!ref || !(ref.pricePerA > 0)) return null;

  const amtA = Number(amountA);
  const suggestB =
    Number.isFinite(amtA) && amtA > 0 ? amtA * ref.pricePerA : 0;
  const suggestStr = formatAmountForInput(suggestB, tokenB.decimals);

  return (
    <div className="k-field p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted">Market price ({ref.source})</span>
        <span className="font-semibold tabular-nums text-ink">
          1 {tokenA.ticker} ≈ {formatRate(ref.pricePerA)} {tokenB.ticker}
        </span>
      </div>
      {suggestStr && (
        <button
          type="button"
          onClick={() => onUse(suggestStr)}
          className="k-btn-ghost mt-2 w-full py-1.5 text-xs"
        >
          Match market — set {tokenB.ticker} to {suggestStr}
        </button>
      )}
      <p className="mt-1 text-[10px] leading-snug text-muted">
        Just a hint from {ref.source}, not gospel — double-check it. You set the real opening
        price.
      </p>
    </div>
  );
}

export function LiquidityPanel({ pool }: { pool: Pool }) {
  const { connected, wallet } = useWallet();
  const address = useAddress();
  // Shared write gating (network + collateral); deposit/withdraw/close are script spends.
  const {
    networkReady,
    wrongNetwork,
    collateralReady,
    needsCollateral,
    recheckCollateral,
    // Shared connect → wrong-network → checking → collateral prefix; the forms append
    // their own flow-specific reasons after it (DRY with the swap/orders gating).
    baseReason,
  } = useWriteGate({ requireCollateral: true });
  const { view, stats, loading, refreshing, error, reload } = usePoolUtxo(pool.id);

  const [tab, setTab] = useState<Tab>("add");
  // Default to the batcher-fulfilled INTENT path once it's live (it wins the per-block pool race
  // on hot pools); until the path ships (pre-Phase-4) default to Direct so the default action is
  // never a dead-end. Direct stays a one-click fallback for cold pools / no-trust mode either way.
  const [mode, setMode] = useState<Mode>(LP_INTENTS_LIVE ? "intent" : "direct");
  // Bumped after a successful post/reclaim so the per-pool intent surface reloads.
  const [intentNonce, setIntentNonce] = useState(0);
  const onPosted = useCallback(() => setIntentNonce((n) => n + 1), []);
  const [slippage, setSlippage] = useState(0.5);
  // A terminal "pool closed" outcome, lifted ABOVE the stats/view gate so the success
  // persists: closing burns the pool UTXO, so onDone()→reload() then resolves to null and
  // would otherwise replace the success panel with a "Pool UTXO not found" error.
  const [closedTxHash, setClosedTxHash] = useState<string | null>(null);

  // The connected wallet's payment key hash — gates the creator-only "Close empty pool"
  // affordance against the pool's `creator`. A never-seeded pool can be torn down by its
  // creator to reclaim the ~2 ₳ seed; once seeded it's immortal (BLUEPRINT §5.1 path c).
  // Resolved only in the async callback (never synchronously in the effect body — the
  // project's effect convention); `connected` gates `isCreator` so a stale value from a
  // previous wallet can't leak through after disconnect.
  const [walletPkh, setWalletPkh] = useState<string | null>(null);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    wallet
      .getChangeAddress()
      .then((addr) => {
        if (!cancelled) setWalletPkh(deserializeAddress(addr).pubKeyHash);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);

  const isCreator =
    connected &&
    !!walletPkh &&
    view?.datum.creator.kind === "key" &&
    view.datum.creator.hash === walletPkh;

  // The wallet's LP balance for this pool, read from the CIP-30 wallet (a wallet call,
  // NOT a chain-data provider call — the data seam stays intact). Keyed on `stats`, which
  // usePoolUtxo refreshes on every reload() (the ↻ Refresh, and onDone after a tx), so
  // the position re-reads whenever the pool view does — rather than going stale (as
  // MeshJS's useAssets did, with no refresh hook). State is only set in the deferred /
  // async callback (the project's effect convention).
  const [lpBalance, setLpBalance] = useState(0n);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      if (!connected || !stats) {
        setLpBalance(0n);
        return;
      }
      const lpUnit = stats.lpUnit;
      wallet
        .getAssets()
        .then((walletAssets) => {
          if (cancelled) return;
          const a = walletAssets.find((x) => x.unit === lpUnit);
          setLpBalance(a ? toBig(a.quantity) : 0n);
        })
        .catch(() => {});
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [connected, wallet, stats]);
  const position = stats ? lpPositionValue(stats, lpBalance) : { a: 0n, b: 0n };

  // Posting an LP intent is a plain payment (no script, no collateral) — so it gates on
  // network only, NOT the collateral step in `baseReason` (which the direct/reclaim paths need).
  const postReason = !connected
    ? "Connect wallet"
    : wrongNetwork
      ? "Wrong network"
      : !networkReady
        ? "Checking network…"
        : null;

  // Terminal: the pool was closed. Persist the success above everything else.
  if (closedTxHash) {
    return (
      <div className="k-card w-full max-w-md p-5 sm:p-6">
        <div className="k-note k-note-success text-sm">
          <div className="flex items-center gap-2">
            <Pip size={26} mood="sparkle" />
            <div className="font-bold text-success">Pool closed ✓</div>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            The pool was permanently burned and the ~2 ₳ seed is on its way back to your
            wallet (~20–40s).
          </p>
          <div className="mt-2 flex items-center justify-between gap-3 text-xs">
            <a
              href={explorerTxUrl(closedTxHash)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              {truncate(closedTxHash, 10, 8)} ↗
            </a>
            <Link href="/pools" className="text-accent hover:underline">
              ← Back to pools
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="k-card w-full max-w-md p-5 sm:p-6">
      <ModeToggle mode={mode} setMode={setMode} />

      <div className="mb-3 flex items-center justify-between px-1">
        <div className="flex rounded-full border border-border bg-surface-sunk p-1 text-sm">
          <TabButton active={tab === "add"} onClick={() => setTab("add")}>
            Add
          </TabButton>
          <TabButton active={tab === "remove"} onClick={() => setTab("remove")}>
            Remove
          </TabButton>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reload}
            disabled={loading || refreshing}
            aria-busy={loading || refreshing}
            title="Refresh pool data"
            aria-label="Refresh pool data"
            className="k-pill px-3 py-1.5 text-xs text-muted hover:text-accent disabled:opacity-70"
          >
            <RefreshIcon busy={loading || refreshing} />
          </button>
          <SlippageSettings
            value={slippage}
            onChange={setSlippage}
            context="liquidity"
          />
        </div>
      </div>

      {loading && !stats && <Skeleton />}

      {error && !stats && (
        <div className="k-note k-note-danger text-sm">
          {error}
        </div>
      )}

      {stats && view && (
        // Keyed by wallet identity: a wallet/account switch remounts the forms, clearing
        // any stale input + success/error from the previous identity.
        <div key={address ?? "disconnected"}>
          <PositionLine
            pool={pool}
            lpBalance={lpBalance}
            circ={stats.circ}
            position={position}
            firstDeposit={stats.firstDeposit}
          />

          {mode === "intent" ? (
            tab === "add" ? (
              <AddIntentForm
                pool={pool}
                stats={stats}
                slippage={slippage}
                wallet={wallet}
                networkReady={networkReady}
                postReason={postReason}
                onSwitchToDirect={() => setMode("direct")}
                onPosted={onPosted}
              />
            ) : (
              <RemoveIntentForm
                pool={pool}
                stats={stats}
                slippage={slippage}
                lpBalance={lpBalance}
                wallet={wallet}
                networkReady={networkReady}
                postReason={postReason}
                onSwitchToDirect={() => setMode("direct")}
                onPosted={onPosted}
              />
            )
          ) : tab === "add" ? (
            <AddForm
              pool={pool}
              view={view}
              stats={stats}
              slippage={slippage}
              wallet={wallet}
              networkReady={networkReady}
              baseReason={baseReason}
              collateralReady={collateralReady}
              needsCollateral={needsCollateral}
              onRecheckCollateral={recheckCollateral}
            />
          ) : (
            <RemoveForm
              pool={pool}
              view={view}
              stats={stats}
              slippage={slippage}
              lpBalance={lpBalance}
              wallet={wallet}
              networkReady={networkReady}
              baseReason={baseReason}
              collateralReady={collateralReady}
              needsCollateral={needsCollateral}
              onRecheckCollateral={recheckCollateral}
            />
          )}

          <PendingLpIntents pool={pool} refreshKey={intentNonce} />

          {stats.firstDeposit && isCreator && (
            <CloseEmptyPool
              pool={pool}
              wallet={wallet}
              connected={connected}
              networkReady={networkReady}
              wrongNetwork={!!wrongNetwork}
              collateralReady={collateralReady}
              needsCollateral={needsCollateral}
              onClosed={setClosedTxHash}
            />
          )}

          {stats.firstDeposit && connected && !isCreator && (
            <div className="k-note k-note-info mt-4 text-xs">
              This pool is empty (no liquidity yet). Only its creator can close an empty
              pool to reclaim the ~2 ₳ seed. Anyone can seed it with the first deposit.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Add liquidity ----

function AddForm({
  pool,
  view,
  stats,
  slippage,
  wallet,
  networkReady,
  baseReason,
  collateralReady,
  needsCollateral,
  onRecheckCollateral,
}: {
  pool: Pool;
  view: PoolView;
  stats: PoolStats;
  slippage: number;
  wallet: ReturnType<typeof useWallet>["wallet"];
  networkReady: boolean;
  baseReason: string | null;
  collateralReady: boolean;
  needsCollateral: boolean;
  onRecheckCollateral: () => void;
}) {
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState(""); // only editable on the first deposit
  const [state, setState] = useState<TxState>({ kind: "idle" });
  // Synchronous re-entry latch (mirrors createPool/closePool) so a double-click can't
  // build two deposits racing the same pool UTXO.
  const submitting = useRef(false);

  // Wallet balances of the two deposit tokens (display-only), + a post-tx balance refresh.
  const { connected, refresh: refreshWallet } = useWallet();
  const lovelace = useLovelace();
  const assets = useAssets();
  const balA = walletBalanceOf(pool.tokenA.unit, lovelace, assets);
  const balB = walletBalanceOf(pool.tokenB.unit, lovelace, assets);

  const first = stats.firstDeposit;

  // Base-unit deltas (plain render computation — the React Compiler memoizes; a
  // try/catch can't live in a useMemo here). Subsequent deposits auto-pair Δb from Δa
  // at the pool ratio (rounded up so the per-share backing holds).
  const sA = toBaseUnits(amountA, pool.tokenA.decimals);
  const deltaA = sA ? toBig(sA) : 0n;

  let deltaB = 0n;
  if (first) {
    const sB = toBaseUnits(amountB, pool.tokenB.decimals);
    deltaB = sB ? toBig(sB) : 0n;
  } else if (deltaA > 0n) {
    try {
      deltaB = pairDeltaB(stats, deltaA);
    } catch {
      deltaB = 0n;
    }
  }

  // First-deposit opening price the creator is SETTING from their two amounts (display
  // only — like the swap mid-price, computed with Number for legibility, not trust-
  // critical). Shown both ways so it reads regardless of which side is ADA.
  const humanA = Number(deltaA) / 10 ** Math.max(0, pool.tokenA.decimals);
  const humanB = Number(deltaB) / 10 ** Math.max(0, pool.tokenB.decimals);
  const showOpening = first && humanA > 0 && humanB > 0;
  const bPerA = showOpening ? humanB / humanA : 0;
  const aPerB = showOpening ? humanA / humanB : 0;

  // Preview the LP received (pure builder; throws on a too-small/invalid intent).
  let preview: { lpToUser: bigint; lockLp: bigint | null; error: string | null } | null =
    null;
  if (deltaA > 0n && deltaB > 0n) {
    try {
      const built = buildDeposit({ view, deltaA, deltaB });
      preview = { lpToUser: built.lpToUser, lockLp: built.lockLp, error: null };
    } catch (e) {
      preview = { lpToUser: 0n, lockLp: null, error: (e as Error).message };
    }
  }

  // The enforced minimum LP the tx will accept if the pool moves before it confirms.
  const minLpOut =
    preview && preview.error === null && preview.lpToUser > 0n
      ? withSlippage(preview.lpToUser, slippage)
      : 0n;

  const canSubmit =
    networkReady &&
    collateralReady &&
    !!preview &&
    preview.error === null &&
    preview.lpToUser > 0n &&
    state.kind !== "busy";

  async function submit() {
    if (!canSubmit || submitting.current || !preview) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      // Dynamically imported so @meshsdk/core tx-building stays out of the initial
      // bundle — only pulled in when the user actually deposits.
      const { depositLiquidity } = await import("@/lib/client/tx");
      const res = await depositLiquidity(wallet, {
        pool,
        deltaA,
        deltaB,
        minLpOut,
      });
      // No auto-reload: during the ~20–40s indexing gap a reload would just re-cache the
      // pre-deposit reserves (and there's no poll to self-heal it). The success banner
      // points the user at ↻ to pull the updated view once it lands.
      setState({ kind: "success", hash: res.txHash });
      setAmountA("");
      setAmountB("");
      // Deposit moved tokens out of the wallet — re-read the balance now (no polling).
      refreshWallet();
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  const label =
    baseReason ??
    (deltaA <= 0n || (first && deltaB <= 0n)
      ? "Enter an amount"
      : preview?.error
        ? "Can’t add that amount"
        : state.kind === "busy"
          ? "Depositing…"
          : first
            ? "Seed pool"
            : "Add liquidity");

  return (
    <div className="mt-3">
      {first && (
        <div className="mb-3 space-y-2">
          <div className="k-note k-note-warn text-xs">
            <div className="flex items-center gap-2">
              <Pip size={22} mood="thinking" />
              <span className="font-bold">You set the opening price</span>
            </div>
            <p className="mt-1">
              You’re first to add liquidity, so your two amounts set the pool’s starting
              price. Try to match what the pair is worth, so it opens fair. A little LP is
              locked in to seed the pool.
            </p>
          </div>

          <FirstDepositReference
            tokenA={pool.tokenA}
            tokenB={pool.tokenB}
            amountA={amountA}
            onUse={(v) => {
              setAmountB(v);
              if (state.kind !== "idle") setState({ kind: "idle" });
            }}
          />

          {showOpening && (
            <div className="k-field p-3 text-xs">
              <div className="mb-1.5 px-1 text-muted">Opening price you’re setting</div>
              <div className="flex items-center justify-between tabular-nums">
                <span className="text-muted">1 {pool.tokenA.ticker}</span>
                <span className="font-semibold text-ink">
                  ≈ {formatRate(bPerA)} {pool.tokenB.ticker}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between tabular-nums">
                <span className="text-muted">1 {pool.tokenB.ticker}</span>
                <span className="font-semibold text-ink">
                  ≈ {formatRate(aPerB)} {pool.tokenA.ticker}
                </span>
              </div>
            </div>
          )}

          <p className="px-1 text-[11px] text-muted">
            This is just the <em>opening</em> price. Trades and new deposits move it from
            here, and the deeper the pool, the less each trade swings it.
          </p>
        </div>
      )}

      <AmountField
        label={`${pool.tokenA.ticker} to add`}
        ticker={pool.tokenA.ticker}
        value={amountA}
        editable
        decimals={pool.tokenA.decimals}
        onChange={(v) => {
          setAmountA(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        balance={connected ? formatUnits(balA.toString(), pool.tokenA.decimals) : undefined}
      />

      <div className="my-2 text-center text-muted">+</div>

      <AmountField
        label={
          first
            ? `${pool.tokenB.ticker} to add`
            : `${pool.tokenB.ticker} (paired at pool ratio)`
        }
        ticker={pool.tokenB.ticker}
        value={
          first ? amountB : deltaB > 0n ? formatUnits(deltaB.toString(), pool.tokenB.decimals) : ""
        }
        editable={first}
        decimals={pool.tokenB.decimals}
        onChange={(v) => {
          setAmountB(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        balance={connected ? formatUnits(balB.toString(), pool.tokenB.decimals) : undefined}
      />

      {!first && deltaB > 0n && (
        <p className="mt-1 px-1 text-[11px] text-muted">
          Paired automatically at the current pool ratio and rounded up, so your share
          backing holds on both sides.
        </p>
      )}

      <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
        <Row label="LP you receive">
          <span className="tabular-nums">
            {preview && preview.error === null && preview.lpToUser > 0n
              ? `≈ ${preview.lpToUser.toLocaleString()} LP`
              : "—"}
          </span>
        </Row>
        <Row label="At least (after slippage)">
          <span className="tabular-nums">
            {minLpOut > 0n ? `${minLpOut.toLocaleString()} LP` : "—"}
          </span>
        </Row>
        <Row label="Max slippage">
          <span className="tabular-nums">{slippage.toFixed(1)}%</span>
        </Row>
      </div>

      {/* Announce the deposit preview to screen readers (the rows update silently as the
          paired Δb / LP estimate recompute) — mirrors the swap card's sr-only live region. */}
      <p aria-live="polite" className="sr-only">
        {preview && preview.error === null && preview.lpToUser > 0n
          ? `LP you receive ≈ ${preview.lpToUser.toLocaleString()}; at least ${minLpOut.toLocaleString()} LP after slippage.`
          : ""}
      </p>

      {deltaA > 0n && (!first || deltaB > 0n) && preview?.error && (
        <div className="k-note k-note-warn mt-3 text-xs">
          {depositErrorMessage(preview.error)}
        </div>
      )}

      {needsCollateral && (
        <CollateralNote onRecheck={onRecheckCollateral} />
      )}

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Liquidity added" />

      <PipOverlay
        show={state.kind === "busy"}
        title={first ? "Seeding the pool…" : "Adding liquidity…"}
      />
    </div>
  );
}

// ---- Remove liquidity ----

function RemoveForm({
  pool,
  view,
  stats,
  slippage,
  lpBalance,
  wallet,
  networkReady,
  baseReason,
  collateralReady,
  needsCollateral,
  onRecheckCollateral,
}: {
  pool: Pool;
  view: PoolView;
  stats: PoolStats;
  slippage: number;
  lpBalance: bigint;
  wallet: ReturnType<typeof useWallet>["wallet"];
  networkReady: boolean;
  baseReason: string | null;
  collateralReady: boolean;
  needsCollateral: boolean;
  onRecheckCollateral: () => void;
}) {
  const [lpInput, setLpInput] = useState("");
  const [state, setState] = useState<TxState>({ kind: "idle" });
  // Synchronous re-entry latch (mirrors createPool/closePool).
  const submitting = useRef(false);

  // The most LP that can be burned: your balance, capped so circulating never drops
  // below the permanently-locked min_liq (else the validator rejects).
  const maxBurnable =
    stats.circ > MIN_LIQ
      ? lpBalance < stats.circ - MIN_LIQ
        ? lpBalance
        : stats.circ - MIN_LIQ
      : 0n;

  // LP is an integer share count (no decimals). Plain render computation.
  const lpToBurn = /^\d+$/.test(lpInput.trim()) ? toBig(lpInput.trim()) : 0n;

  let preview: { recvA: bigint; recvB: bigint; error: string | null } | null = null;
  if (lpToBurn > 0n) {
    try {
      const built = buildWithdraw({ view, lpToBurn });
      preview = { recvA: built.recvA, recvB: built.recvB, error: null };
    } catch (e) {
      preview = { recvA: 0n, recvB: 0n, error: (e as Error).message };
    }
  }

  // Enforced minimums the tx will accept if the pool moves before it confirms.
  const minAOut =
    preview && preview.error === null ? withSlippage(preview.recvA, slippage) : 0n;
  const minBOut =
    preview && preview.error === null ? withSlippage(preview.recvB, slippage) : 0n;

  const overBalance = lpToBurn > lpBalance;
  const canSubmit =
    networkReady &&
    collateralReady &&
    !!preview &&
    preview.error === null &&
    !overBalance &&
    state.kind !== "busy";

  async function submit() {
    if (!canSubmit || submitting.current || !preview) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      // Dynamically imported so @meshsdk/core tx-building stays out of the initial
      // bundle — only pulled in when the user actually withdraws.
      const { withdrawLiquidity } = await import("@/lib/client/tx");
      const res = await withdrawLiquidity(wallet, {
        pool,
        lpToBurn,
        minAOut,
        minBOut,
      });
      // No auto-reload (see AddForm): a reload here would re-cache the pre-withdraw
      // reserves during the indexing gap. The banner points the user at ↻.
      setState({ kind: "success", hash: res.txHash });
      setLpInput("");
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  const label =
    baseReason ??
    (lpToBurn <= 0n
      ? "Enter LP amount"
      : overBalance
        ? "More than your LP"
        : preview?.error
          ? "Can't withdraw that amount"
          : state.kind === "busy"
            ? "Withdrawing…"
            : "Remove liquidity");

  return (
    <div className="mt-3">
      <div className="k-field p-3.5">
        <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted">
          <span>LP to burn</span>
          <button
            type="button"
            onClick={() => setLpInput(maxBurnable.toString())}
            className="text-accent hover:underline"
          >
            Max {maxBurnable.toLocaleString()}
          </button>
        </div>
        <input
          inputMode="numeric"
          value={lpInput}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*$/.test(v)) {
              setLpInput(v);
              if (state.kind !== "idle") setState({ kind: "idle" });
            }
          }}
          className="k-input text-3xl font-extrabold tabular-nums text-ink"
        />
      </div>

      <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
        <Row label={`${pool.tokenA.ticker} you receive`}>
          <span className="tabular-nums">
            {preview && preview.error === null
              ? `≈ ${formatUnits(preview.recvA.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker}`
              : "—"}
          </span>
        </Row>
        <Row label={`${pool.tokenB.ticker} you receive`}>
          <span className="tabular-nums">
            {preview && preview.error === null
              ? `≈ ${formatUnits(preview.recvB.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}`
              : "—"}
          </span>
        </Row>
        <Row label="At least (after slippage)">
          <span className="tabular-nums">
            {preview && preview.error === null
              ? `${formatUnits(minAOut.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker} + ${formatUnits(minBOut.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}`
              : "—"}
          </span>
        </Row>
        <Row label="Max slippage">
          <span className="tabular-nums">{slippage.toFixed(1)}%</span>
        </Row>
      </div>

      {/* Announce the withdraw preview to screen readers — mirrors the swap card's
          sr-only live region (the "you receive" / "at least" rows update silently). */}
      <p aria-live="polite" className="sr-only">
        {preview && preview.error === null
          ? `You receive ≈ ${formatUnits(preview.recvA.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker} plus ${formatUnits(preview.recvB.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}; at least ${formatUnits(minAOut.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker} and ${formatUnits(minBOut.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker} after slippage.`
          : ""}
      </p>

      {lpToBurn > 0n && !overBalance && preview?.error && (
        <div className="k-note k-note-warn mt-3 text-xs">
          {withdrawErrorMessage(preview.error)}
        </div>
      )}

      {needsCollateral && (
        <CollateralNote onRecheck={onRecheckCollateral} />
      )}

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Liquidity removed" />

      <PipOverlay show={state.kind === "busy"} title="Removing liquidity…" />
    </div>
  );
}

// ---- LP mode toggle (batcher-fulfilled intent vs the direct pool spend) ----

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="mb-3">
      <div className="flex rounded-2xl border border-border bg-surface-sunk p-1 text-xs">
        <ModeButton active={mode === "intent"} onClick={() => setMode("intent")}>
          <span className="font-bold">Batcher</span>
          <span className="ml-1 text-[10px] opacity-70">recommended</span>
        </ModeButton>
        <ModeButton active={mode === "direct"} onClick={() => setMode("direct")}>
          <span className="font-bold">Direct</span>
          <span className="ml-1 text-[10px] opacity-70">advanced</span>
        </ModeButton>
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted">
        {mode === "intent"
          ? "A batcher fulfils your deposit/withdraw like an order, so it never loses the per-block race for the pool on a busy market. You post a tip; it’s the only thing the batcher keeps."
          : "You spend the pool yourself in one tx (no batcher, no trust). Best on a quiet pool — on a busy one your tx can keep losing the pool to the batcher."}
      </p>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-xl px-3 py-2 transition-colors ${
        active ? "k-toggle-active" : "text-muted hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

// ---- shared intent controls (tip + deadline) ----

const DEADLINE_OPTIONS: { label: string; hours: number }[] = [
  { label: "No deadline", hours: 0 },
  { label: "1 hour", hours: 1 },
  { label: "6 hours", hours: 6 },
  { label: "24 hours", hours: 24 },
];

function IntentControls({
  tipAda,
  onTipChange,
  tipLovelace,
  deadlineHours,
  onDeadlineChange,
}: {
  tipAda: string;
  onTipChange: (v: string) => void;
  tipLovelace: bigint;
  deadlineHours: number;
  onDeadlineChange: (h: number) => void;
}) {
  const lowTip = tipLovelace > 0n && tipLovelace < RECOMMENDED_MIN_TIP;
  return (
    <div className="mt-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="k-field p-3">
          <div className="mb-1 px-1 text-xs text-muted">Batcher tip (₳)</div>
          <input
            inputMode="decimal"
            value={tipAda}
            placeholder="1.0"
            onChange={(e) => {
              if (withinDecimals(e.target.value, 6)) onTipChange(e.target.value);
            }}
            className="k-input text-lg font-bold tabular-nums text-ink"
          />
        </div>
        <div className="k-field p-3">
          <div className="mb-1 px-1 text-xs text-muted">Expires</div>
          <select
            value={deadlineHours}
            onChange={(e) => onDeadlineChange(Number(e.target.value))}
            className="k-input w-full bg-transparent text-sm font-medium text-ink"
          >
            {DEADLINE_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {lowTip && (
        <p className="mt-1 px-1 text-[11px] text-warning">
          A low tip may not be picked up — a batcher only fulfils intents whose tip covers its
          fee. ~0.5 ₳ is a safe floor.
        </p>
      )}
    </div>
  );
}

/** Convert a human ADA tip string to lovelace (0n if blank/invalid). */
function tipToLovelace(tipAda: string): bigint {
  const s = toBaseUnits(tipAda, 6);
  return s ? toBig(s) : 0n;
}

/** Shown for the first deposit on the intent path — it must be seeded directly. */
function FirstDepositIntentNote({ onSwitchToDirect }: { onSwitchToDirect: () => void }) {
  return (
    <div className="mt-3 k-note k-note-info text-xs">
      <div className="flex items-center gap-2">
        <Pip size={22} mood="thinking" />
        <span className="font-bold">This pool needs its first deposit</span>
      </div>
      <p className="mt-1">
        Seeding a brand-new pool sets its opening price, so it’s done directly (a batcher can’t
        fulfil the very first deposit). Switch to Direct to seed it; once it has liquidity,
        batcher deposits work here.
      </p>
      <button
        type="button"
        onClick={onSwitchToDirect}
        className="k-btn-ghost mt-2 px-3 py-1.5 text-xs"
      >
        Switch to Direct to seed →
      </button>
    </div>
  );
}

/** A small banner when the batcher LP path isn't live on this network yet (pre-Phase-4). */
function NotLiveNote({ onSwitchToDirect }: { onSwitchToDirect: () => void }) {
  return (
    <div className="mt-3 k-note k-note-warn text-xs">
      <div className="flex items-center gap-2">
        <Pip size={22} mood="sleepy" />
        <span className="font-bold">Batcher LP is rolling out</span>
      </div>
      <p className="mt-1">
        Batcher-processed deposits/withdrawals launch with the next contract deploy. For now,
        use the Direct path — it works on every pool.
      </p>
      <button
        type="button"
        onClick={onSwitchToDirect}
        className="k-btn-ghost mt-2 px-3 py-1.5 text-xs"
      >
        Use Direct →
      </button>
    </div>
  );
}

// ---- Add liquidity (intent / batcher) ----

function AddIntentForm({
  pool,
  stats,
  slippage,
  wallet,
  networkReady,
  postReason,
  onSwitchToDirect,
  onPosted,
}: {
  pool: Pool;
  stats: PoolStats;
  slippage: number;
  wallet: ReturnType<typeof useWallet>["wallet"];
  networkReady: boolean;
  postReason: string | null;
  onSwitchToDirect: () => void;
  onPosted: () => void;
}) {
  const [amountA, setAmountA] = useState("");
  const [tipAda, setTipAda] = useState("0.5");
  const [deadlineHours, setDeadlineHours] = useState(0);
  const [state, setState] = useState<TxState>({ kind: "idle" });
  const submitting = useRef(false);

  // Wallet balances of the two deposit tokens (display-only), + a post-tx balance refresh.
  const { connected, refresh: refreshWallet } = useWallet();
  const lovelace = useLovelace();
  const assets = useAssets();
  const balA = walletBalanceOf(pool.tokenA.unit, lovelace, assets);
  const balB = walletBalanceOf(pool.tokenB.unit, lovelace, assets);

  const first = stats.firstDeposit;

  // Pair Δb from Δa at the pool ratio (rounded up), exactly like the direct AddForm — a
  // balanced deposit minimises the excess the batcher would ride back to the owner.
  const sA = toBaseUnits(amountA, pool.tokenA.decimals);
  const deltaA = sA ? toBig(sA) : 0n;
  let deltaB = 0n;
  if (!first && deltaA > 0n) {
    try {
      deltaB = pairDeltaB(stats, deltaA);
    } catch {
      deltaB = 0n;
    }
  }

  const tipLovelace = tipToLovelace(tipAda);

  let preview: { fairShares: bigint; minShares: bigint; error: string | null } | null = null;
  if (!first && deltaA > 0n && deltaB > 0n) {
    try {
      const q = quoteLpDeposit(stats, deltaA, deltaB, slippage);
      preview = { fairShares: q.fairShares, minShares: q.minShares, error: null };
    } catch (e) {
      preview = { fairShares: 0n, minShares: 0n, error: (e as Error).message };
    }
  }

  const canSubmit =
    LP_INTENTS_LIVE &&
    networkReady &&
    !first &&
    !!preview &&
    preview.error === null &&
    preview.fairShares > 0n &&
    tipLovelace > 0n &&
    state.kind !== "busy";

  async function submit() {
    if (!canSubmit || submitting.current || !preview) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      const { postLpIntentDeposit } = await import("@/lib/client/tx");
      const deadline =
        deadlineHours > 0 ? BigInt(nowMs() + deadlineHours * 3_600_000) : null;
      const res = await postLpIntentDeposit(wallet, {
        pool,
        amountA: deltaA,
        amountB: deltaB,
        minShares: preview.minShares,
        tip: tipLovelace,
        deadline,
      });
      recordLpIntent(res.owner, {
        ref: res.ref,
        txHash: res.txHash,
        poolNft: pool.id,
        action: "deposit",
        aTicker: pool.tokenA.ticker,
        aDecimals: pool.tokenA.decimals,
        bTicker: pool.tokenB.ticker,
        bDecimals: pool.tokenB.decimals,
        depositA: deltaA.toString(),
        depositB: deltaB.toString(),
        tip: tipLovelace.toString(),
        ts: nowMs(),
      });
      setState({ kind: "success", hash: res.txHash });
      setAmountA("");
      onPosted();
      // Posting the intent locked tokens + tip — re-read the balance now (no polling).
      refreshWallet();
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  if (first) return <FirstDepositIntentNote onSwitchToDirect={onSwitchToDirect} />;
  if (!LP_INTENTS_LIVE) return <NotLiveNote onSwitchToDirect={onSwitchToDirect} />;

  const label =
    postReason ??
    (deltaA <= 0n
      ? "Enter an amount"
      : tipLovelace <= 0n
        ? "Set a batcher tip"
        : preview?.error
          ? "Can’t add that amount"
          : state.kind === "busy"
            ? "Posting…"
            : "Add liquidity (batcher)");

  return (
    <div className="mt-3">
      <AmountField
        label={`${pool.tokenA.ticker} to add`}
        ticker={pool.tokenA.ticker}
        value={amountA}
        editable
        decimals={pool.tokenA.decimals}
        onChange={(v) => {
          setAmountA(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        balance={connected ? formatUnits(balA.toString(), pool.tokenA.decimals) : undefined}
      />

      <div className="my-2 text-center text-muted">+</div>

      <AmountField
        label={`${pool.tokenB.ticker} (paired at pool ratio)`}
        ticker={pool.tokenB.ticker}
        value={deltaB > 0n ? formatUnits(deltaB.toString(), pool.tokenB.decimals) : ""}
        editable={false}
        decimals={pool.tokenB.decimals}
        onChange={() => {}}
        balance={connected ? formatUnits(balB.toString(), pool.tokenB.decimals) : undefined}
      />

      <IntentControls
        tipAda={tipAda}
        onTipChange={(v) => {
          setTipAda(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        tipLovelace={tipLovelace}
        deadlineHours={deadlineHours}
        onDeadlineChange={setDeadlineHours}
      />

      <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
        <Row label="LP you receive">
          <span className="tabular-nums">
            {preview && preview.error === null && preview.fairShares > 0n
              ? `≈ ${preview.fairShares.toLocaleString()} LP`
              : "—"}
          </span>
        </Row>
        <Row label="At least (slippage floor)">
          <span className="tabular-nums">
            {preview && preview.error === null && preview.minShares > 0n
              ? `${preview.minShares.toLocaleString()} LP`
              : "—"}
          </span>
        </Row>
        <Row label="Max slippage">
          <span className="tabular-nums">{slippage.toFixed(1)}%</span>
        </Row>
      </div>

      <p aria-live="polite" className="sr-only">
        {preview && preview.error === null && preview.fairShares > 0n
          ? `LP you receive ≈ ${preview.fairShares.toLocaleString()}; floor ${preview.minShares.toLocaleString()} LP.`
          : ""}
      </p>

      {deltaA > 0n && deltaB > 0n && preview?.error && (
        <div className="k-note k-note-warn mt-3 text-xs">
          {depositErrorMessage(preview.error)}
        </div>
      )}

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Deposit intent posted" intent />

      <PipOverlay
        show={state.kind === "busy"}
        title="Tucking your deposit into the garden…"
      />
    </div>
  );
}

// ---- Remove liquidity (intent / batcher) ----

function RemoveIntentForm({
  pool,
  stats,
  slippage,
  lpBalance,
  wallet,
  networkReady,
  postReason,
  onSwitchToDirect,
  onPosted,
}: {
  pool: Pool;
  stats: PoolStats;
  slippage: number;
  lpBalance: bigint;
  wallet: ReturnType<typeof useWallet>["wallet"];
  networkReady: boolean;
  postReason: string | null;
  onSwitchToDirect: () => void;
  onPosted: () => void;
}) {
  const [lpInput, setLpInput] = useState("");
  const [tipAda, setTipAda] = useState("0.5");
  const [deadlineHours, setDeadlineHours] = useState(0);
  const [state, setState] = useState<TxState>({ kind: "idle" });
  const submitting = useRef(false);

  // Max LP: your balance, capped so circulating never drops below the locked min_liq.
  const maxBurnable =
    stats.circ > MIN_LIQ
      ? lpBalance < stats.circ - MIN_LIQ
        ? lpBalance
        : stats.circ - MIN_LIQ
      : 0n;

  const lpToBurn = /^\d+$/.test(lpInput.trim()) ? toBig(lpInput.trim()) : 0n;
  const tipLovelace = tipToLovelace(tipAda);

  let preview: {
    fairA: bigint;
    fairB: bigint;
    minA: bigint;
    minB: bigint;
    error: string | null;
  } | null = null;
  if (lpToBurn > 0n) {
    try {
      const q = quoteLpWithdraw(stats, lpToBurn, slippage);
      preview = { ...q, error: null };
    } catch (e) {
      preview = { fairA: 0n, fairB: 0n, minA: 0n, minB: 0n, error: (e as Error).message };
    }
  }

  const overBalance = lpToBurn > lpBalance;
  const canSubmit =
    LP_INTENTS_LIVE &&
    networkReady &&
    !!preview &&
    preview.error === null &&
    !overBalance &&
    tipLovelace > 0n &&
    state.kind !== "busy";

  async function submit() {
    if (!canSubmit || submitting.current || !preview) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      const { postLpIntentWithdraw } = await import("@/lib/client/tx");
      const deadline =
        deadlineHours > 0 ? BigInt(nowMs() + deadlineHours * 3_600_000) : null;
      const res = await postLpIntentWithdraw(wallet, {
        pool,
        lpAmount: lpToBurn,
        minA: preview.minA,
        minB: preview.minB,
        tip: tipLovelace,
        deadline,
      });
      recordLpIntent(res.owner, {
        ref: res.ref,
        txHash: res.txHash,
        poolNft: pool.id,
        action: "withdraw",
        aTicker: pool.tokenA.ticker,
        aDecimals: pool.tokenA.decimals,
        bTicker: pool.tokenB.ticker,
        bDecimals: pool.tokenB.decimals,
        lp: lpToBurn.toString(),
        tip: tipLovelace.toString(),
        ts: nowMs(),
      });
      setState({ kind: "success", hash: res.txHash });
      setLpInput("");
      onPosted();
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  if (!LP_INTENTS_LIVE) return <NotLiveNote onSwitchToDirect={onSwitchToDirect} />;

  const label =
    postReason ??
    (lpToBurn <= 0n
      ? "Enter LP amount"
      : overBalance
        ? "More than your LP"
        : tipLovelace <= 0n
          ? "Set a batcher tip"
          : preview?.error
            ? "Can’t withdraw that amount"
            : state.kind === "busy"
              ? "Posting…"
              : "Remove liquidity (batcher)");

  return (
    <div className="mt-3">
      <div className="k-field p-3.5">
        <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted">
          <span>LP to redeem</span>
          <button
            type="button"
            onClick={() => setLpInput(maxBurnable.toString())}
            className="text-accent hover:underline"
          >
            Max {maxBurnable.toLocaleString()}
          </button>
        </div>
        <input
          inputMode="numeric"
          value={lpInput}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*$/.test(v)) {
              setLpInput(v);
              if (state.kind !== "idle") setState({ kind: "idle" });
            }
          }}
          className="k-input text-3xl font-extrabold tabular-nums text-ink"
        />
      </div>

      <IntentControls
        tipAda={tipAda}
        onTipChange={(v) => {
          setTipAda(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        tipLovelace={tipLovelace}
        deadlineHours={deadlineHours}
        onDeadlineChange={setDeadlineHours}
      />

      <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
        <Row label={`${pool.tokenA.ticker} you receive`}>
          <span className="tabular-nums">
            {preview && preview.error === null
              ? `≈ ${formatUnits(preview.fairA.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker}`
              : "—"}
          </span>
        </Row>
        <Row label={`${pool.tokenB.ticker} you receive`}>
          <span className="tabular-nums">
            {preview && preview.error === null
              ? `≈ ${formatUnits(preview.fairB.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}`
              : "—"}
          </span>
        </Row>
        <Row label="At least (slippage floor)">
          <span className="tabular-nums">
            {preview && preview.error === null
              ? `${formatUnits(preview.minA.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker} + ${formatUnits(preview.minB.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}`
              : "—"}
          </span>
        </Row>
        <Row label="Max slippage">
          <span className="tabular-nums">{slippage.toFixed(1)}%</span>
        </Row>
      </div>

      <p aria-live="polite" className="sr-only">
        {preview && preview.error === null
          ? `You receive ≈ ${formatUnits(preview.fairA.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker} plus ${formatUnits(preview.fairB.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}; floor ${formatUnits(preview.minA.toString(), pool.tokenA.decimals)} ${pool.tokenA.ticker} and ${formatUnits(preview.minB.toString(), pool.tokenB.decimals)} ${pool.tokenB.ticker}.`
          : ""}
      </p>

      {lpToBurn > 0n && !overBalance && preview?.error && (
        <div className="k-note k-note-warn mt-3 text-xs">
          {withdrawErrorMessage(preview.error)}
        </div>
      )}

      {/* UX honesty (§13): a withdraw intent has no reclaim-to-underlying backstop. */}
      <div className="k-note k-note-info mt-3 text-[11px]">
        If no batcher fulfils it, you can reclaim the intent anytime — but a withdraw reclaim
        returns your <strong>LP tokens</strong>, not the underlying (converting LP back to
        reserves is itself a pool spend). On a quiet pool, Direct withdraws to underlying in one tx.
      </div>

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Withdraw intent posted" intent />

      <PipOverlay show={state.kind === "busy"} title="Lining up your withdrawal…" />
    </div>
  );
}

// ---- Close empty pool (creator-only, never-seeded) ----

function CloseEmptyPool({
  pool,
  wallet,
  connected,
  networkReady,
  wrongNetwork,
  collateralReady,
  needsCollateral,
  onClosed,
}: {
  pool: Pool;
  wallet: ReturnType<typeof useWallet>["wallet"];
  connected: boolean;
  networkReady: boolean;
  wrongNetwork: boolean;
  collateralReady: boolean;
  needsCollateral: boolean;
  onClosed: (txHash: string) => void;
}) {
  // Collapsed by default: on an empty pool you created, the PRIMARY action is to seed it
  // (the Add form above). The destructive close is a secondary escape hatch, tucked behind
  // a quiet link so it doesn't crowd or compete with the first deposit.
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<TxState>({ kind: "idle" });
  const submitting = useRef(false);

  // The single reason the close is currently blocked, surfaced up front (not only at
  // the confirm step) so the user knows before committing.
  const gateReason = !connected
    ? "Connect wallet"
    : wrongNetwork
      ? "Wrong network"
      : needsCollateral
        ? "Set wallet collateral"
        : null;
  const gated = !networkReady || !collateralReady;

  async function submit() {
    if (!networkReady || !collateralReady || submitting.current) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      // Dynamically imported so @meshsdk/core tx-building stays out of the initial
      // bundle — only pulled in when the creator actually closes the pool.
      const { closePool } = await import("@/lib/client/tx");
      const res = await closePool(wallet, pool);
      // Lift the terminal outcome to the parent — it persists above the pool-UTXO
      // reload, which now resolves to null (the pool is burned).
      onClosed(res.txHash);
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-3 w-full text-center text-xs text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-danger"
      >
        Created this pool by mistake? Close the empty pool →
      </button>
    );
  }

  return (
    <div className="k-note k-note-danger mt-3">
      <div className="px-0.5 text-xs text-muted">
        You created this empty pool. Closing permanently burns it and returns the
        ~2 ₳ seed to your wallet. (Once it has liquidity it can never be closed.)
      </div>

      {!confirming ? (
        <button
          type="button"
          disabled={gated}
          onClick={() => {
            setConfirming(true);
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
          className="k-btn-danger-soft mt-2 w-full text-sm"
        >
          {gateReason ?? "Close empty pool"}
        </button>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={state.kind === "busy"}
            className="k-btn-ghost flex-1 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={gated || state.kind === "busy"}
            onClick={submit}
            className="k-btn-danger flex-1 text-sm"
          >
            {gateReason ?? (state.kind === "busy" ? "Closing…" : "Yes, burn pool")}
          </button>
        </div>
      )}

      {state.kind === "error" && (
        <div className="k-note k-note-danger mt-2 break-words text-xs">
          {state.message}
        </div>
      )}

      <PipOverlay show={state.kind === "busy"} title="Closing the pool…" />
    </div>
  );
}

/** Map a `buildDeposit` throw into a user-facing explanation (distinct causes). */
function depositErrorMessage(err: string): string {
  if (/first deposit too small|must exceed min_liq/i.test(err)) {
    return "This first deposit is too small to seed the pool. It must mint more than the locked minimum liquidity. Increase both amounts.";
  }
  if (/rounds to zero/i.test(err)) {
    return "That amount is too small to mint any LP. Increase it.";
  }
  if (/LP slippage|below minimum/i.test(err)) {
    return "The pool moved since this quote. Hit ↻ to refresh, then try again, or raise your slippage.";
  }
  if (/zero asset_a reserve|drop below min_liq/i.test(err)) {
    return "The pool data shown may be a step behind a recent change. Hit ↻ to refresh, then try again.";
  }
  return err;
}

/** Map a `buildWithdraw` throw into a user-facing explanation. */
function withdrawErrorMessage(err: string): string {
  if (/no circulating LP|more than circulating/i.test(err)) {
    return "The pool data shown may be a step behind a recent deposit. Hit ↻ to refresh, then try again.";
  }
  if (/below min_liq/i.test(err)) {
    return "That would leave less than the pool's permanently-locked minimum liquidity. Withdraw a little less (use Max for the largest allowed).";
  }
  if (/rounds to zero/i.test(err)) {
    return "That amount is too small to return any tokens. Increase it.";
  }
  return err;
}

// ---- shared bits ----

function PositionLine({
  pool,
  lpBalance,
  circ,
  position,
  firstDeposit,
}: {
  pool: Pool;
  lpBalance: bigint;
  circ: bigint;
  position: { a: bigint; b: bigint };
  firstDeposit: boolean;
}) {
  // LP is a share of the pool: your fraction of circulating LP = your fraction of the
  // reserves. Shown as a % so the raw counts (up to ~9.2e18) stay legible.
  const sharePct =
    circ > 0n && lpBalance > 0n
      ? Number((lpBalance * 1_000_000n) / circ) / 10_000
      : 0;
  const shareText =
    sharePct === 0 ? "—" : sharePct < 0.01 ? "<0.01%" : `${sharePct.toFixed(2)}%`;
  return (
    <div className="k-field p-3 text-xs">
      <div className="mb-2 text-muted">Your patch</div>
      {lpBalance > 0n ? (
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 tabular-nums">
          <dt
            className="cursor-help text-muted"
            title="LP — your share of the garden (the pool's liquidity tokens you hold)"
          >
            LP
          </dt>
          <dd className="text-right font-medium text-ink">{lpBalance.toLocaleString()}</dd>
          <dt className="text-muted">Share</dt>
          <dd className="text-right text-ink">{shareText}</dd>
          <dt className="text-muted">{pool.tokenA.ticker}</dt>
          <dd className="text-right text-ink">
            {formatUnits(position.a.toString(), pool.tokenA.decimals)}
          </dd>
          <dt className="text-muted">{pool.tokenB.ticker}</dt>
          <dd className="text-right text-ink">
            {formatUnits(position.b.toString(), pool.tokenB.decimals)}
          </dd>
        </dl>
      ) : (
        <div className="text-muted">
          {firstDeposit ? "No liquidity yet." : "You hold no LP in this pool."}
        </div>
      )}
    </div>
  );
}

function AmountField({
  label,
  ticker,
  value,
  editable,
  decimals,
  onChange,
  balance,
}: {
  label: string;
  ticker: string;
  value: string;
  editable: boolean;
  /** Max fractional digits accepted while typing (the token's precision; 0 if unknown). */
  decimals: number;
  onChange: (v: string) => void;
  /** Optional wallet balance of this token, already formatted (display-only). */
  balance?: string;
}) {
  return (
    <div className="k-field p-3.5">
      <div className="mb-2 px-1 text-xs text-muted">{label}</div>
      <div className="flex items-center gap-3">
        <input
          inputMode="decimal"
          value={value}
          readOnly={!editable}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (withinDecimals(v, decimals)) onChange(v);
          }}
          className={`k-input text-3xl font-extrabold tabular-nums ${
            editable ? "text-ink" : "text-muted"
          }`}
        />
        <span className="k-pill shrink-0 text-sm">
          {ticker}
        </span>
      </div>
      {balance !== undefined && (
        <div className="mt-2 px-1 text-[11px] text-muted">
          Balance: <span className="tabular-nums">{balance}</span> {ticker}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1.5 transition-colors ${
        active ? "k-toggle-active font-bold" : "text-muted hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      {children}
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
      className="k-btn mt-3 w-full py-3.5 text-sm"
    >
      {label}
    </button>
  );
}

function ResultBanner({
  state,
  verb,
  intent,
}: {
  state: TxState;
  verb: string;
  /** An intent post (vs a direct on-chain action) — different follow-up copy. */
  intent?: boolean;
}) {
  if (state.kind === "success") {
    return (
      <div className="k-note k-note-success relative mt-3 text-xs">
        <Confetti />
        <div className="relative flex items-center gap-2">
          <Pip size={26} mood={intent ? "love" : "cheer"} />
          <div className="font-bold text-success">{verb} ✓</div>
        </div>
        <p className="mt-0.5 text-muted">
          {intent
            ? "A batcher will fulfil it shortly. It appears under “Your LP intents” below — you can grab it back anytime until then."
            : "Settling in (~20–40s). Hit ↻ above to refresh your position once it lands."}
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
          <Pip size={26} mood="calm" still />
          <div className="font-bold">Hmm, that didn’t go through</div>
        </div>
        <div className="mt-1 break-words opacity-90">{state.message}</div>
      </div>
    );
  }
  return null;
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-2xl border border-border bg-surface-sunk"
        />
      ))}
    </div>
  );
}
