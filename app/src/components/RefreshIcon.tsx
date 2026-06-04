/**
 * The ↻ refresh glyph, shared across every refresh button so they all signal work the
 * same way: it spins while `busy`. Pair it with `disabled={busy}` + `aria-busy` on the
 * button so a manual refresh never feels like nothing happened.
 */
export function RefreshIcon({ busy = false }: { busy?: boolean }) {
  return (
    <span aria-hidden className={`inline-block ${busy ? "animate-spin" : ""}`}>
      ↻
    </span>
  );
}
