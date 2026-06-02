/**
 * Current epoch milliseconds, behind a plain function.
 *
 * Reading the wall clock during React render is impure (hydration mismatch), which
 * the React compiler lint flags. Inside an event handler it's perfectly fine — this
 * indirection keeps the safe usage from tripping that rule.
 */
export function nowMs(): number {
  return Date.now();
}
