"use client";

import { useMemo, useState } from "react";
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
  depositLiquidity,
  withdrawLiquidity,
} from "@/lib/client/tx";
import { toUserMessage } from "@/lib/client/errors";
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

/** Apply a slippage haircut (bps) to a computed amount, flooring. */
function withSlippage(amount: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(slippagePct * 100));
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
        <SlippageSettings value={slippage} onChange={setSlippage} />
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
              slippage={slippage}
              lpBalance={lpBalance}
              wallet={wallet}
              networkReady={networkReady}
              wrongNetwork={!!wrongNetwork}
              connected={connected}
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
              ? "Amount too small or too large"
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
            onClick={() => setLpInput(lpBalance.toString())}
            className="text-accent hover:underline"
          >
            Max {lpBalance.toLocaleString()}
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

      <SubmitButton disabled={!canSubmit} onClick={submit} label={label} />
      <ResultBanner state={state} verb="Liquidity removed" />
    </div>
  );
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
