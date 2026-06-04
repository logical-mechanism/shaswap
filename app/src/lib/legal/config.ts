/**
 * Legal / compliance configuration — the single source of truth for the entity
 * name, contact, and document versioning used by `/terms`, `/privacy`, and the
 * pre-connect click-through gate (see `components/legal/`).
 *
 * Posture (decided 2026-06-04): we mirror SundaeSwap's actual compliance setup —
 * static Terms + Privacy plus a click-through acceptance before wallet connect.
 * Deliberately NOT here: IP geofencing and OFAC/SDN wallet screening. SundaeSwap
 * enforces neither; both would introduce a mortal external dependency that breaks
 * ShaSwap's hyperstructure invariant (CLAUDE.md) and could impede non-custodial
 * reclaim. ShaSwap is a true DEX — the protocol is reachable without this site.
 *
 * These documents are a DRAFT modeled on SundaeSwap's; a licensed US attorney must
 * review and finalize them before mainnet. See `documentation/` if a posture note
 * is added to the blueprint.
 */

/** Single source for the documents' effective date — drives both the displayed
 * "Last Updated" line and the accepted-terms version. Bump this one string when the
 * text changes. */
const TERMS_DATE = "2026-06-04";

export const LEGAL = {
  /**
   * The operating entity named in the documents and the entity↔protocol separation
   * clause. The documents themselves remain a DRAFT pending counsel review before
   * mainnet (the attorney memo recommended an LLC as a liability shield, mirroring
   * SundaeSwap Labs, Inc.).
   */
  entity: "Logical Mechanism LLC",

  /** Contact address surfaced in the documents. */
  contactEmail: "support@logicalmechanism.io",

  /** The protocol/site name (kept distinct from the entity on purpose). */
  protocol: "ShaSwap",

  /** Human "Last Updated" date shown on the documents. */
  lastUpdated: TERMS_DATE,

  /**
   * The accepted-terms version stored against the user's acceptance; the click-through
   * gate re-prompts whenever it changes — how we avoid SundaeSwap's stale-terms trap.
   * Shares `TERMS_DATE` with `lastUpdated` so a date change and a re-prompt can never
   * drift apart (the trap is bumping the displayed date but not the version).
   */
  version: TERMS_DATE,
} as const;
