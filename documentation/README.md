# ShaSwap — Documentation

The authoritative design and supporting specs for ShaSwap. Start with the **blueprint**;
everything else elaborates or operationalizes it.

## Source of truth

- [`BLUEPRINT.md`](BLUEPRINT.md) — **the authoritative design.** Protocol, principles
  (§3), settlement rules (§5.2), trust-anchor wiring (§5.4), threat model (§8), open
  decisions (§12), risks (§13). Code and blueprint must never silently diverge; a change
  that alters the design bumps the blueprint `Revision:` in the same commit.

## Specs (`spec/`)

| Doc | What |
|---|---|
| [`spec/clearing-price.md`](spec/clearing-price.md) | Uniform-price clearing derivation |
| [`spec/ada-triple-role.md`](spec/ada-triple-role.md) | ADA as tip / min-ADA / traded side (§5.2.1) |
| [`spec/partial-fills.md`](spec/partial-fills.md) | Proportional tip + one-level remainder |
| [`spec/ex-unit-spike.md`](spec/ex-unit-spike.md) | Measured per-order verification cost (§13.1) |
| [`spec/economic-parameters.md`](spec/economic-parameters.md) | The permanent constants (fee, tip, min-ADA) + protocol-param-drift analysis |
| [`spec/liveness-and-recovery.md`](spec/liveness-and-recovery.md) | Order lifecycle, rollover, reclaim backstop, honest censorship-resistance |
| [`spec/data-availability.md`](spec/data-availability.md) | Provider seam, failure modes, self-hostable read path |
| [`spec/liquidity-bootstrap.md`](spec/liquidity-bootstrap.md) | First-pool seeding & first-deposit math |

## Launch (`launch/`)

| Doc | What |
|---|---|
| [`launch/mainnet-checklist.md`](launch/mainnet-checklist.md) | Step-by-step go-live gate (deploy → verify → flip) |
| [`launch/batcher-operations.md`](launch/batcher-operations.md) | Operator runbook: config, monitoring, recovery |

## Source papers

The academic basis (batch auctions, MEV / LVR, PA-AMM). [`BLUEPRINT.md`](BLUEPRINT.md) §4
explains how each maps onto ShaSwap.

- **Augmenting Batch Exchanges with CFMMs** — Ramseyer, Goyal, Goel, Mazières (EC '24) — [arXiv:2210.04929](https://arxiv.org/abs/2210.04929)
- **SAMM: Sharded Automated Market Maker** — Chen, Vaisman, Eyal ('25) — [arXiv:2406.05568](https://arxiv.org/abs/2406.05568)
- **Automated Market Making and Loss-Versus-Rebalancing** — Milionis, Moallemi, Roughgarden, Zhang ('24) — [arXiv:2208.06046](https://arxiv.org/abs/2208.06046)
- **Partially Active Automated Market Makers** — Ko ('26) — [arXiv:2602.09887](https://arxiv.org/abs/2602.09887)

## Other

- [`app-data-caching.md`](app-data-caching.md) — the dApp's no-background-polling read model.
