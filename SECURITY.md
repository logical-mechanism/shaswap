# Security Policy

ShaSwap is a fully on-chain, non-custodial, **immutable** batch-auction DEX on Cardano.
There are no admin keys, no upgrade authority, and no privileged operator
([`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md) §3/§9). That shapes this whole
policy: **a deployed validator cannot be patched.** The response to a confirmed flaw in the
immutable set is to warn users to reclaim/withdraw and to ship a corrected **v2 as new
contracts (new script hashes)** — never to "fix" the live ones in place.

## Reporting a vulnerability

**Report privately. Do not open a public issue, pull request, or social post for a
suspected vulnerability** until we have had a chance to respond.

- Email **support@logicalmechanism.io**. For a first contact you can send a no-details "I have something" message and
  request a key for encrypted follow-up.
- Please include: the affected component, the commit hash or deployed **script hash**, a
  description of the issue, and a proof-of-concept / reproduction if you have one.

We are a small team. We **aim to acknowledge within 3 business days** and to keep you
updated as we assess. Where a fix means a v2 redeploy + liquidity migration, we will
coordinate disclosure timing with you.

## Scope

**In scope**
- **On-chain validators** — `contracts/`: settlement (`S`), `order`, `pool`, `pool_mint`,
  `lp_intent`.
- **Reference batcher** — `batcher/`.
- **dApp** — `app/`, including the data-access layer and wallet integration.

**Out of scope — accepted, documented design residues, not vulnerabilities.**
Please read [`BLUEPRINT.md` §13](documentation/BLUEPRINT.md) before reporting. These are
known and accepted by design:
- No order privacy — intents and limit prices are **public on-chain** (§13.8).
- A resting limit order is a **free option** on a slow chain (§13.5).
- Batch-composition MEV is **bounded by the per-order floor, not eliminated** (§13.3).
- LVR is **mitigated, not cured** (§13.9).
- A hot-pool LP-withdraw intent reclaims your **LP tokens, not the underlying** (§13.11).
- The perfectly-netted trader↔trader **Scope A residue** (§5.2.7, Rev 26).

A report showing any of these is **exploitable beyond its documented bound** *is* in scope
and very welcome.

## Audit & disclosure posture (honest statement)

- The on-chain validators have been reviewed **in-house** with
  [audit-machine](https://github.com/logicalmechanism/audit_machine); the current report is
  [`contracts/audit/audit_report.md`](contracts/audit/audit_report.md) (0 Critical/High/Medium,
  one Low creation-time gap, plus informational items).
- **There has been no external third-party firm audit.** This is a known, accepted-risk
  posture for v1 (see [`documentation/launch/mainnet-checklist.md`](documentation/launch/mainnet-checklist.md));
  treat the protocol accordingly and at your own risk.
- We currently **cannot offer a paid bug bounty.** We will **publicly credit** researchers
  who disclose responsibly, unless you prefer to remain anonymous.

## If you are a user worried about your funds

ShaSwap is non-custodial. Every well-formed order is **reclaimable by your own signature**
at any time, independent of any solver or operator (an LP-*withdraw* intent reclaims to your
LP tokens — see §13.11). If something looks wrong, reclaim your resting orders/intents from
the dApp (or directly on-chain), and watch this file and the announced channels for guidance.
