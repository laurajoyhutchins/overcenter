# Retired artifact lineage

These references preserve the precise historical sources removed from the active working tree under [Overcenter deletion queue #766](https://github.com/laurajoyhutchins/overcenter/issues/766). The immutable accepted starting commit is `2d7ddea66638564fa8b6fc30e9a690329d26e8ac`. Git history is the evidence archive, not a substitute for running current verification. This ledger does **not** assert that the historical proofs have been independently subsumed.

## Production-callable importance experiment

The maintained registry previously claimed an executable callable-ranking analyzer, but its `analyze.ts` and `analyze.test.ts` were already absent at the accepted revision. Its nonexecuting `config.json` and stale reproduction contract were retired. See [`experiments/production-criticality-ranking/config.json`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/experiments/production-criticality-ranking/config.json), [`experiments/production-criticality-ranking/README.md`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/experiments/production-criticality-ranking/README.md), and [`experiments/registry.json`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/experiments/registry.json). The retained mutation-probe tooling remains in the same directory and continues to be covered by the existing checks. Historical evaluation was `515a771257ca0ac21cede5410144be5e02da4f7b`, workflow run `35673456200`, with a mixed outcome and known model limitations.

## Repository-transaction design lineage

- [`docs/superpowers/plans/2026-09-29-repository-transactions-status.md`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/superpowers/plans/2026-09-29-repository-transactions-status.md): point-in-time integration status, branch assumptions, hosted-admission blockers and outstanding work.
- [`docs/superpowers/plans/2026-09-29-repository-transactions.md`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/superpowers/plans/2026-09-29-repository-transactions.md): staged implementation plan, design constraints, failure-oriented review focus and proposed interfaces; not an assertion that all stages were deployed.
- [`docs/superpowers/specs/2026-09-29-repository-transactions.md`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/superpowers/specs/2026-09-29-repository-transactions.md): approved design choices, exact transaction identity and source/evidence boundary, explicit completion criteria. Its design lineage is retained in this pinned version; current implementations and checks remain authoritative for supported behavior.

These are historical proposal and status documents. Their deletion is **not** evidence of successful delivery of every proposed capability.

## 4×4 migration-era formal artifacts

The following were migration research artifacts, not inputs to the current `formal/check.sh` run. Their original source and negative controls remain retrievable at the pinned revision:

- [`docs/migrations/4x4-strangler/formal/BrokenRecoveryCertainty.cfg`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/migrations/4x4-strangler/formal/BrokenRecoveryCertainty.cfg)
- [`docs/migrations/4x4-strangler/formal/BrokenReservationIsAuthority.cfg`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/migrations/4x4-strangler/formal/BrokenReservationIsAuthority.cfg)
- [`docs/migrations/4x4-strangler/formal/EffectAdmission.dl`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/migrations/4x4-strangler/formal/EffectAdmission.dl)
- [`docs/migrations/4x4-strangler/formal/FourByFourEffect.cfg`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/migrations/4x4-strangler/formal/FourByFourEffect.cfg)
- [`docs/migrations/4x4-strangler/formal/FourByFourEffect.lean`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/migrations/4x4-strangler/formal/FourByFourEffect.lean)
- [`docs/migrations/4x4-strangler/formal/FourByFourEffect.tla`](https://github.com/laurajoyhutchins/overcenter/blob/2d7ddea66638564fa8b6fc30e9a690329d26e8ac/docs/migrations/4x4-strangler/formal/FourByFourEffect.tla)

The TLA+ negative controls tested reservation being mistaken for authority and recovery certainty. The Lean and Datalog files explored migration-specific relational effect admission. These artifacts have **not** been reclassified as proofs furnished by the current formal suite. Reintroduce the old models from Git history before making claims requiring their unique counterexamples.

## Recovery-routing comparison

The legacy settlement-to-recovery mapping no longer runs in production `src/authority/recovery.ts`; it remains a test-only independent comparator in `test/recovery-relations-shadow.test.ts`. The existing exhaustive 32-valuation test still expects the derived planner to prefer reconciliation in contradictory terminal-evidence cases, rather than treating a legacy settlement outcome as authoritative.

## Provenance / reintroduction

All removed artifacts can be restored exactly from `2d7ddea66638564fa8b6fc30e9a690329d26e8ac` by their path (for example `git show 2d7ddea66638564fa8b6fc30e9a690329d26e8ac:docs/migrations/4x4-strangler/formal/FourByFourEffect.tla`). Removing them from the tip does not rewrite repository history. No CI checks were weakened to justify these retirements.
