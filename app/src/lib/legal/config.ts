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

  /**
   * Human "Last Updated" date shown on the documents (ISO date). Bump when the text
   * changes. Keep in lockstep with `version` below so a real edit re-prompts users.
   */
  lastUpdated: "2026-06-04",

  /**
   * The accepted-terms version. The click-through gate stores this against the user's
   * acceptance; bumping it (alongside `lastUpdated`) re-prompts everyone — this is how
   * we avoid SundaeSwap's stale-terms trap, where a 2021 click-through still stands.
   */
  version: "2026-06-04",
} as const;
