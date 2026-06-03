"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { deserializeAddress } from "@meshsdk/core";
import { useAssets, useNetwork, useWallet } from "@meshsdk/react";
import type { Pool } from "@/lib/data";
import { APP_CONFIG, explorerTxUrl } from "@/lib/config";
import { usePoolUtxo } from "@/hooks/usePoolUtxo";
import {
  buildDeposit,
  buildWithdraw,
  lpPositionValue,
  pairDeltaB,
  type PoolStats,
  type PoolView,
} from "@/lib/chain/lp";
import {
  closePool,
  depositLiquidity,
  withdrawLiquidity,
} from "@/lib/client/tx";
import { toUserMessage } from "@/lib/client/errors";
import { MIN_LIQ } from "@/lib/chain/deployment";
import { formatUnits, toBaseUnits, truncate } from "@/lib/format";
import { SlippageSettings } from "@/components/swap/SlippageSettings";

type Tab = "add" | "remove";

type TxState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "success"; hash: string }
  | { kind: "error"; message: string };

function toBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Apply a slippage haircut (bps) to a computed amount, flooring. Clamped to [0,100%]. */
function withSlippage(amount: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(slippagePct * 100))));
  return (amount * (10_000n - bps)) / 10_000n;
}

export function LiquidityPanel({ pool }: { pool: Pool }) {
  const { connected, wallet } = useWallet();
  const networkId = useNetwork();
  const assets = useAssets();
  const { view, stats, loading, error, reload } = usePoolUtxo(pool.id);

  const [tab, setTab] = useState<Tab>("add");
  const [slippage, setSlippage] = useState(0.5);

  const wrongNetwork =
    connected && networkId !== undefined && networkId !== APP_CONFIG.networkId;
  const networkReady = connected && networkId === APP_CONFIG.networkId;

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

  // The wallet's LP balance for this pool, and its value in reserves.
  const lpBalance = useMemo(() => {
    if (!stats || !assets) return 0n;
    const a = assets.find((x) => x.unit === stats.lpUnit);
    return a ? toBig(a.quantity) : 0n;
  }, [assets, stats]);
  const position = stats ? lpPositionValue(stats, lpBalance) : { a: 0n, b: 0n };

  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-surface/80 p-4 shadow-2xl backdrop-blur-sm sm:p-5">
      <div className="mb-3 flex items-center justify-between px-1">
        <div className="flex rounded-xl border border-white/10 bg-black/20 p-0.5 text-sm">
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
            title="Refresh pool data"
            aria-label="Refresh pool data"
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            ↻
          </button>
          <SlippageSettings value={slippage} onChange={setSlippage} />
        </div>
      </div>

      {loading && !stats && <Skeleton />}

      {error && !stats && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {stats && view && (
        <>
          <PositionLine
            pool={pool}
            lpBalance={lpBalance}
            position={position}
            firstDeposit={stats.firstDeposit}
          />

          {tab === "add" ? (
            <AddForm
              pool={pool}
              view={view}
              stats={stats}
              slippage={slippage}
              wallet={wallet}
              networkReady={networkReady}
              wrongNetwork={!!wrongNetwork}
              connected={connected}
              onDone={reload}
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
              wrongNetwork={!!wrongNetwork}
              connected={connected}
              onDone={reload}
            />
          )}

          {stats.firstDeposit && isCreator && (
            <CloseEmptyPool
              pool={pool}
              wallet={wallet}
              connected={connected}
              networkReady={networkReady}
              wrongNetwork={!!wrongNetwork}
              onDone={reload}
            />
          )}
        </>
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
  wrongNetwork,
  connected,
  onDone,
}: {
  pool: Pool;
  view: PoolView;
  stats: PoolStats;
  slippage: number;
  wallet: ReturnType<typeof useWallet>["wallet"];
  networkReady: boolean;
  wrongNetwork: boolean;
  connected: boolean;
  onDone: () => void;
}) {
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState(""); // only editable on the first deposit
  const [state, setState] = useState<TxState>({ kind: "idle" });

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

  const canSubmit =
    networkReady && !!preview && preview.error === null && preview.lpToUser > 0n && state.kind !== "busy";

  async function submit() {
    if (!canSubmit || !preview) return;
    setState({ kind: "busy" });
    try {
      const res = await depositLiquidity(wallet, {
        pool,
        deltaA,
        deltaB,
        minLpOut: withSlippage(preview.lpToUser, slippage),
      });
      setState({ kind: "success", hash: res.txHash });
      setAmountA("");
      setAmountB("");
      onDone();
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    }
  }

  const label = !connected
    ? "Connect wallet"
    : wrongNetwork
      ? "Wrong network"
      : !networkReady
        ? "Checking network…"
        : deltaA <= 0n || (first && deltaB <= 0n)
          ? "Enter an amount"
          : preview?.error
            ? "Amount too small"
            : state.kind === "busy"
              ? "Depositing…"
              : first
                ? "Seed pool"
                : "Add liquidity";

  return (
    <div className="mt-3">
      {first && (
        <div className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-300">
          This pool has no circulating LP yet — you’re the first depositor. LP minted
          = √(reserveA · reserveB); 1000 LP is permanently locked to seed the pool.
        </div>
      )}

      <AmountField
        label={`${pool.tokenA.ticker} to add`}
        ticker={pool.tokenA.ticker}
        value={amountA}
        editable
        onChange={(v) => {
          setAmountA(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
      />

      <div className="my-2 text-center text-muted">+</div>

      <AmountField
        label={
          first
            ? `${pool.tokenB.ticker} to add`
            : `${pool.tokenB.ticker} (paired automatically)`
        }
        ticker={pool.tokenB.ticker}
        value={
          first ? amountB : deltaB > 0n ? formatUnits(deltaB.toString(), pool.tokenB.decimals) : ""
        }
        editable={first}
        onChange={(v) => {
          setAmountB(v);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
      />

      <div className="mt-3 space-y-1.5 px-1 text-xs text-muted">
        <Row label="LP you receive">
          <span className="tabular-nums">
            {preview && preview.error === null && preview.lpToUser > 0n
              ? `≈ ${preview.lpToUser.toLocaleString()} LP`
              : "—"}
          </span>
        </Row>
        <Row label="Max slippage">
          <span className="tabular-nums">{slippage.toFixed(1)}%</span>
        </Row>
      </div>

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Liquidity added" />
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
  wrongNetwork,
  connected,
  onDone,
}: {
  pool: Pool;
  view: PoolView;
  stats: PoolStats;
  slippage: number;
  lpBalance: bigint;
  wallet: ReturnType<typeof useWallet>["wallet"];
  networkReady: boolean;
  wrongNetwork: boolean;
  connected: boolean;
  onDone: () => void;
}) {
  const [lpInput, setLpInput] = useState("");
  const [state, setState] = useState<TxState>({ kind: "idle" });

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

  const overBalance = lpToBurn > lpBalance;
  const canSubmit =
    networkReady &&
    !!preview &&
    preview.error === null &&
    !overBalance &&
    state.kind !== "busy";

  async function submit() {
    if (!canSubmit || !preview) return;
    setState({ kind: "busy" });
    try {
      const res = await withdrawLiquidity(wallet, {
        pool,
        lpToBurn,
        minAOut: withSlippage(preview.recvA, slippage),
        minBOut: withSlippage(preview.recvB, slippage),
      });
      setState({ kind: "success", hash: res.txHash });
      setLpInput("");
      onDone();
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    }
  }

  const label = !connected
    ? "Connect wallet"
    : wrongNetwork
      ? "Wrong network"
      : !networkReady
        ? "Checking network…"
        : lpToBurn <= 0n
          ? "Enter LP amount"
          : overBalance
            ? "More than your LP"
            : preview?.error
              ? "Can't withdraw that amount"
              : state.kind === "busy"
                ? "Withdrawing…"
                : "Remove liquidity";

  return (
    <div className="mt-3">
      <div className="rounded-xl border border-white/5 bg-black/20 p-3">
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
          className="w-full bg-transparent text-2xl font-medium outline-none placeholder:text-muted/50"
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
        <Row label="Max slippage">
          <span className="tabular-nums">{slippage.toFixed(1)}%</span>
        </Row>
      </div>

      {lpToBurn > 0n && !overBalance && preview?.error && (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-300">
          {withdrawErrorMessage(preview.error)}
        </div>
      )}

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Liquidity removed" />
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
  onDone,
}: {
  pool: Pool;
  wallet: ReturnType<typeof useWallet>["wallet"];
  connected: boolean;
  networkReady: boolean;
  wrongNetwork: boolean;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<TxState>({ kind: "idle" });
  const submitting = useRef(false);

  async function submit() {
    if (!networkReady || submitting.current) return;
    submitting.current = true;
    setState({ kind: "busy" });
    try {
      const res = await closePool(wallet, pool);
      setState({ kind: "success", hash: res.txHash });
      onDone();
    } catch (e) {
      setState({ kind: "error", message: toUserMessage(e) });
    } finally {
      submitting.current = false;
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-red-500/15 bg-red-500/[0.03] p-3">
      <div className="px-0.5 text-xs text-muted">
        You created this empty pool. Closing permanently burns it and returns the
        ~2 ₳ seed to your wallet. (Once it has liquidity it can never be closed.)
      </div>

      {state.kind === "success" ? (
        <div className="mt-2 text-xs">
          <div className="font-medium text-accent">Pool closed ✓</div>
          <p className="mt-0.5 text-muted">
            The ~2 ₳ seed is on its way back to your wallet.
          </p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <a
              href={explorerTxUrl(state.hash)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              {truncate(state.hash, 10, 8)} ↗
            </a>
            <Link href="/pools" className="text-accent hover:underline">
              ← Back to pools
            </Link>
          </div>
        </div>
      ) : !confirming ? (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
          className="mt-2 w-full rounded-xl border border-red-500/30 py-2.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/10"
        >
          Close empty pool
        </button>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={state.kind === "busy"}
            className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!networkReady || state.kind === "busy"}
            onClick={submit}
            className="flex-1 rounded-xl bg-red-500/80 py-2.5 text-sm font-semibold text-black transition-opacity hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-muted"
          >
            {!connected
              ? "Connect wallet"
              : wrongNetwork
                ? "Wrong network"
                : state.kind === "busy"
                  ? "Closing…"
                  : "Confirm — burn pool"}
          </button>
        </div>
      )}

      {state.kind === "error" && (
        <div className="mt-2 break-words rounded-xl border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-300">
          {state.message}
        </div>
      )}
    </div>
  );
}

/** Map a `buildWithdraw` throw into a user-facing explanation. */
function withdrawErrorMessage(err: string): string {
  if (/no circulating LP|more than circulating/i.test(err)) {
    return "The pool data shown may be a step behind a recent deposit. It refreshes automatically every few seconds — or hit ↻ — then try again.";
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
  position,
  firstDeposit,
}: {
  pool: Pool;
  lpBalance: bigint;
  position: { a: bigint; b: bigint };
  firstDeposit: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/10 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted">Your position</span>
        <span className="tabular-nums font-medium">
          {lpBalance.toLocaleString()} LP
        </span>
      </div>
      {lpBalance > 0n && (
        <div className="mt-1 text-right tabular-nums text-muted">
          ≈ {formatUnits(position.a.toString(), pool.tokenA.decimals)}{" "}
          {pool.tokenA.ticker} +{" "}
          {formatUnits(position.b.toString(), pool.tokenB.decimals)}{" "}
          {pool.tokenB.ticker}
        </div>
      )}
      {firstDeposit && lpBalance === 0n && (
        <div className="mt-1 text-right text-muted/70">no liquidity yet</div>
      )}
    </div>
  );
}

function AmountField({
  label,
  ticker,
  value,
  editable,
  onChange,
}: {
  label: string;
  ticker: string;
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-3">
      <div className="mb-2 px-1 text-xs text-muted">{label}</div>
      <div className="flex items-center gap-3">
        <input
          inputMode="decimal"
          value={value}
          readOnly={!editable}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*\.?\d*$/.test(v)) onChange(v);
          }}
          className={`w-full bg-transparent text-2xl font-medium outline-none placeholder:text-muted/50 ${
            editable ? "" : "text-muted"
          }`}
        />
        <span className="shrink-0 rounded-lg bg-white/5 px-2.5 py-1 text-sm font-medium">
          {ticker}
        </span>
      </div>
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
      className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
        active ? "bg-white/10 text-foreground" : "text-muted hover:text-foreground"
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
      className="mt-3 w-full rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3.5 text-sm font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:from-white/10 disabled:to-white/10 disabled:text-muted"
    >
      {label}
    </button>
  );
}

function ResultBanner({ state, verb }: { state: TxState; verb: string }) {
  if (state.kind === "success") {
    return (
      <div className="mt-3 rounded-xl border border-accent/20 bg-accent/10 p-3 text-xs">
        <div className="font-medium text-accent">{verb} ✓</div>
        <p className="mt-0.5 text-muted">
          Confirming on-chain (~20–40s). Your position updates once it lands.
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
        <div className="font-medium">Transaction failed</div>
        <div className="mt-1 break-words text-red-300/80">{state.message}</div>
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
          className="h-14 animate-pulse rounded-xl border border-white/5 bg-white/5"
        />
      ))}
    </div>
  );
}
