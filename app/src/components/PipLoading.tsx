import { Pip } from "./Pip";

/** A friendly Pip-led loading state (replaces bare shimmer on page loads). */
export function PipLoading({
  label = "Pip’s on it…",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 py-10 text-center text-sm text-muted ${className}`}
      role="status"
      aria-live="polite"
    >
      <Pip size={52} mood="thinking" float />
      <span>{label}</span>
    </div>
  );
}
