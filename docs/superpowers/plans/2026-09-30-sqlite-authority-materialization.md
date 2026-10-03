# SQLite authority materialization implementation plan

> Execute inline with the existing superpowers development and review workflow.

**Goal:** SQLite is the verified local fact/replay hot path without a central Overcenter service.
**Architecture:** Preserve Git object identities/publication and shared ref CAS. Materialize immutable objects in SQLite; one SqliteFactStore composes these responsibilities.
**Spec:** ../specs/2026-09-30-sqlite-authority-materialization.md
**Constraints:** No npm runtime dependency; preserve source Git, exact revisions, migration-free existing history, all gates and fail-closed authority loss.

- [ ] Write cache/replica/CAS/integrity tests and witness their failure.
- [ ] Extract verified Git object decoding, narrow Git to publication/CAS, implement SQLite object materialization and wire the sole kernel.
- [ ] Move direct bundled stores to test-only oracles; run differential traces against the actual composition.
- [ ] Promote independent-cache multi-host, crash/reopen, tamper and zero-Git warm replay tests; measure local replay separately from remote authority.
- [ ] Reconcile physical bindings, callers, proof artifacts and decision record; retain all mainline tests.
- [ ] Review, run full checks and unchanged TCB admission, publish exact candidate and obtain hosted evidence before merge.
