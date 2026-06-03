import type { ReactNode } from "react";

/**
 * "Needs collateral" warning with an in-app re-check, shared by every script-spend flow
 * (LP add/remove, create pool, reclaim order). `useWalletCollateral` also auto-rechecks
 * when the user returns to the app, so the button is a manual nudge. Pass `children` to
 * tailor the explanation per flow.
 */
export function CollateralNote({
  onRecheck,
  children,
}: {
  onRecheck: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="k-note k-note-warn mt-3 flex items-start justify-between gap-2 text-xs">
      <span>
        {children ??
          "This action spends a script UTXO, so your wallet needs a collateral UTXO. Set one in your wallet, then re-check."}
      </span>
      <button
        type="button"
        onClick={onRecheck}
        className="k-btn-ghost shrink-0 px-2.5 py-1 text-[11px]"
      >
        Re-check
      </button>
    </div>
  );
}
