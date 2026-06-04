"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * "Needs collateral" warning with an in-app re-check, shared by every script-spend flow
 * (LP add/remove, create pool, reclaim order). `useWalletCollateral` also auto-rechecks
 * when the user returns to the app; this button is a manual nudge.
 *
 * The re-check itself is silent (it just re-queries the wallet), so it used to feel like
 * nothing happened: flash a "Checking…" state so the click is visibly doing something, and
 * once it's been tried, nudge a reconnect for the common case where a wallet keeps
 * reporting no collateral. If collateral IS now set, this whole note unmounts. Pass
 * `children` to tailor the explanation per flow.
 */
export function CollateralNote({
  onRecheck,
  children,
}: {
  onRecheck: () => void;
  children?: ReactNode;
}) {
  const [checking, setChecking] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);

  // getCollateral resolves fast; hold "Checking…" briefly so the action reads as live.
  useEffect(() => {
    if (!checking) return;
    const id = setTimeout(() => setChecking(false), 800);
    return () => clearTimeout(id);
  }, [checking]);

  return (
    <div className="k-note k-note-warn mt-3 flex items-start justify-between gap-2 text-xs">
      <div>
        <span>
          {children ??
            "This needs a collateral set in your wallet. Add one, then re-check."}
        </span>
        {checkedOnce && !checking && (
          <span className="mt-1 block text-[11px] opacity-80">
            Still not finding one. Make sure it’s set in your wallet, or reconnect.
          </span>
        )}
      </div>
      <button
        type="button"
        disabled={checking}
        onClick={() => {
          if (checking) return;
          setChecking(true);
          setCheckedOnce(true);
          onRecheck();
        }}
        className="k-btn-ghost shrink-0 px-2.5 py-1 text-[11px] disabled:opacity-70"
      >
        {checking ? "Checking…" : "Re-check"}
      </button>
    </div>
  );
}
