"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Pool, TokenInfo } from "@/lib/data";
import { usePools } from "@/hooks/usePools";
import { networkLabel } from "@/lib/config";
import { formatUnits } from "@/lib/format";
import { Pip } from "@/components/Pip";

type SortKey = "liquidity" | "pair" | "fee";

/**
 * A pair groups every pool that trades the same two assets (across fee tiers),
 * in a canonical orientation so the same pair always lands in one group.
 */
interface PairGroup {
  key: string;
  x: TokenInfo;
  y: TokenInfo;
  rows: { pool: Pool; rX: string; rY: string }[];
  liveCount: number;
  totalY: bigint; // summed reserve of Y over seeded pools — a liquidity proxy for sorting
  fees: number[]; // sorted unique fee bps
}

function toBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Canonical pair orientation: ADA sits second; otherwise order by unit. */
function canonical(pool: Pool) {
  const aAda = pool.tokenA.unit === "lovelace";
  const bAda = pool.tokenB.unit === "lovelace";
  const swap = aAda && !bAda ? true : bAda && !aAda ? false : pool.tokenA.unit > pool.tokenB.unit;
  return swap
    ? { x: pool.tokenB, y: pool.tokenA, rX: pool.reserveB, rY: pool.reserveA }
    : { x: pool.tokenA, y: pool.tokenB, rX: pool.reserveA, rY: pool.reserveB };
}

export default function PoolsPage() {
  const { pools, loading, error } = usePools();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("liquidity");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [visible, setVisible] = useState(9);

  const groups = useMemo<PairGroup[]>(() => {
    const byKey = new Map<string, PairGroup>();
    for (const pool of pools) {
      if (hideEmpty && pool.firstDeposit) continue;
      const c = canonical(pool);
      const key = `${c.x.unit}|${c.y.unit}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, x: c.x, y: c.y, rows: [], liveCount: 0, totalY: 0n, fees: [] };
        byKey.set(key, g);
      }
      g.rows.push({ pool, rX: c.rX, rY: c.rY });
      if (!pool.firstDeposit) {
        g.liveCount += 1;
        g.totalY += toBig(c.rY);
      }
      if (!g.fees.includes(pool.feeBps)) g.fees.push(pool.feeBps);
    }
    const list = [...byKey.values()];
    for (const g of list) {
      g.fees.sort((a, b) => a - b);
      g.rows.sort((a, b) => a.pool.feeBps - b.pool.feeBps);
    }
    return list;
  }, [pools, hideEmpty]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? groups.filter((g) => {
          const hay =
            `${g.x.ticker} ${g.y.ticker} ${g.x.name} ${g.y.name} ${g.x.ticker}/${g.y.ticker}`.toLowerCase();
          return hay.includes(q);
        })
      : groups;
    const sorted = [...matched].sort((a, b) => {
      if (sort === "pair")
        return `${a.x.ticker}/${a.y.ticker}`.localeCompare(`${b.x.ticker}/${b.y.ticker}`);
      if (sort === "fee") return (a.fees[0] ?? 0) - (b.fees[0] ?? 0);
      // liquidity: seeded pairs first, by total Y reserve
      return a.totalY > b.totalY ? -1 : a.totalY < b.totalY ? 1 : 0;
    });
    return sorted;
  }, [groups, query, sort]);

  const poolCount = pools.length;
  const shown = filtered.slice(0, visible);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ink">Pools</h1>
          <p className="mt-1 text-sm text-muted">
            Every pair Pip looks after. Pop one open to add or pull out liquidity.
          </p>
          {!loading && !error && poolCount > 0 && (
            <p className="mt-1 text-xs text-muted/80">
              {groups.length} {groups.length === 1 ? "pair" : "pairs"} · {poolCount}{" "}
              {poolCount === 1 ? "pool" : "pools"} on {networkLabel()}
            </p>
          )}
        </div>
        <Link href="/pools/create" className="k-btn shrink-0 px-4 py-2.5 text-sm">
          + Create pool
        </Link>
      </header>

      {error && (
        <div className="k-note k-note-danger text-sm">Couldn’t load the pools: {error}</div>
      )}

      {loading && <SkeletonRows />}

      {!loading && !error && poolCount === 0 && (
        <Empty
          mood="sleepy"
          title="No pools yet"
          body="Be the first to open one — Pip will keep it cozy."
        >
          <Link href="/pools/create" className="k-btn mt-4 px-4 py-2 text-sm">
            Create the first pool →
          </Link>
        </Empty>
      )}

      {!loading && !error && poolCount > 0 && (
        <>
          <Controls
            query={query}
            onQuery={(v) => {
              setQuery(v);
              setVisible(9);
            }}
            sort={sort}
            onSort={setSort}
            hideEmpty={hideEmpty}
            onHideEmpty={(v) => {
              setHideEmpty(v);
              setVisible(9);
            }}
          />

          {filtered.length === 0 ? (
            <Empty
              mood="thinking"
              title="No pairs match"
              body={
                hideEmpty
                  ? "Nothing here with that name — try clearing the search or showing empty pools."
                  : "Nothing here with that name. Try another ticker, like ADA."
              }
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {shown.map((g) => (
                  <PairCard key={g.key} group={g} />
                ))}
              </div>
              {filtered.length > shown.length && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setVisible((v) => v + 9)}
                    className="k-btn-ghost px-5 py-2.5 text-sm"
                  >
                    Show more pairs ({filtered.length - shown.length})
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Controls({
  query,
  onQuery,
  sort,
  onSort,
  hideEmpty,
  onHideEmpty,
}: {
  query: string;
  onQuery: (v: string) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  hideEmpty: boolean;
  onHideEmpty: (v: boolean) => void;
}) {
  const SORTS: { key: SortKey; label: string }[] = [
    { key: "liquidity", label: "Liquidity" },
    { key: "pair", label: "A–Z" },
    { key: "fee", label: "Fee" },
  ];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5">
      <label className="k-field flex min-w-[12rem] flex-1 items-center gap-2 px-3 py-2">
        <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0 text-muted" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search pairs — e.g. ADA"
          aria-label="Search pairs"
          className="k-input text-sm text-ink"
        />
      </label>

      <div className="flex items-center gap-1 rounded-full border border-border bg-surface-sunk p-1">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSort(s.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
              sort === s.key ? "bg-accent/12 text-accent" : "text-muted hover:text-accent"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onHideEmpty(!hideEmpty)}
        aria-pressed={hideEmpty}
        className={`rounded-full border px-3 py-2 text-xs font-bold transition-colors ${
          hideEmpty
            ? "border-accent/40 bg-accent/12 text-accent"
            : "border-border bg-surface text-muted hover:text-accent"
        }`}
      >
        {hideEmpty ? "✓ " : ""}Hide empty
      </button>
    </div>
  );
}

function PairCard({ group }: { group: PairGroup }) {
  const { x, y, rows, liveCount, fees } = group;
  const feeLabel =
    fees.length === 1
      ? `${(fees[0] / 100).toFixed(2)}%`
      : `${fees.length} fee tiers`;
  // Aggregate reserves across seeded pools in this pair.
  const totalX = rows.reduce((acc, r) => (r.pool.firstDeposit ? acc : acc + toBig(r.rX)), 0n);
  const totalY = group.totalY;

  return (
    <div className="k-card flex flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <PairIcons x={x} y={y} />
          <div className="min-w-0">
            <div className="truncate font-display text-base font-extrabold text-ink">
              {x.ticker} <span className="text-muted">/</span> {y.ticker}
            </div>
            <div className="text-[11px] text-muted">
              {liveCount > 0 ? (
                <span className="tabular-nums">
                  {formatUnits(totalX.toString(), x.decimals)} {x.ticker} ·{" "}
                  {formatUnits(totalY.toString(), y.decimals)} {y.ticker}
                </span>
              ) : (
                "No liquidity yet"
              )}
            </div>
          </div>
        </div>
        <span className="k-chip k-chip-muted shrink-0">{feeLabel}</span>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-border pt-3">
        {rows.map(({ pool, rX, rY }) => (
          <Link
            key={pool.id}
            href={`/pools/${encodeURIComponent(pool.id)}`}
            className="group flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-sunk"
          >
            <span className="flex items-center gap-2 text-xs">
              <span className="k-chip k-chip-accent tabular-nums">
                {(pool.feeBps / 100).toFixed(2)}%
              </span>
              {pool.firstDeposit ? (
                <span className="k-chip k-chip-warn">Needs first deposit</span>
              ) : (
                <span className="tabular-nums text-muted">
                  {formatUnits(rX, x.decimals)} {x.ticker} · {formatUnits(rY, y.decimals)}{" "}
                  {y.ticker}
                </span>
              )}
            </span>
            <span className="text-xs font-bold text-muted transition-colors group-hover:text-accent">
              Manage →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function PairIcons({ x, y }: { x: TokenInfo; y: TokenInfo }) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      <TokenAvatar token={x} />
      <span className="-ml-2.5">
        <TokenAvatar token={y} />
      </span>
    </span>
  );
}

function TokenAvatar({ token, size = 30 }: { token: TokenInfo; size?: number }) {
  if (token.icon) {
    return (
      <span
        className="rounded-full bg-surface-sunk bg-cover bg-center ring-2 ring-surface"
        style={{ width: size, height: size, backgroundImage: `url("${token.icon}")` }}
      />
    );
  }
  return (
    <span
      className="grid place-items-center rounded-full bg-gradient-to-br from-pink to-lavender text-[10px] font-bold text-white ring-2 ring-surface"
      style={{ width: size, height: size }}
    >
      {token.ticker.slice(0, 2)}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-[1.75rem] border border-border bg-surface-sunk"
        />
      ))}
    </div>
  );
}

function Empty({
  mood,
  title,
  body,
  children,
}: {
  mood: "sleepy" | "thinking";
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="k-card flex flex-col items-center px-4 py-12 text-center">
      <Pip size={64} mood={mood} />
      <div className="mt-3 font-display text-lg font-extrabold text-ink">{title}</div>
      <p className="mt-1 max-w-xs text-sm text-muted">{body}</p>
      {children}
    </div>
  );
}
