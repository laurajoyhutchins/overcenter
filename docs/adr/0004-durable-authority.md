# ADR-0004: Git is the sole production durable fact store

Status: Accepted design; merge requires exact-head hosted evidence.
Date: 2026-09-30.
Inspected starting revision: `8ff48188ed5d79cb9ea48c9c4183217a44430ac0`.
Rebased and checked against refreshed main: `86df306f0fbaf9290bb3390a801e616a8237ae58`.

The decisive requirement is durable exact-head coordination between independent,
ephemeral trusted command runners without an additional authority service.

1. **Current topology.** `project.advance`, `project.submit`, source settlement,
   and hostile-evidence reconciliation instantiate `GitOvercenterKernel` on
   separate Actions runners. Their common authority is the remote
   `refs/overcenter/state`, not the checked-out source branch. Trusted command jobs
   have storage credentials; task workers receive bounded assignments and submit
   evidence. `KernelCore` centralizes admission rules, but its instances are not a
   single network service. Read-only inspection found authority head
   `93ec8f3e2d60a2892e3e2738b38fadfd67345e7c` with 26 commits.

2. **Logical equivalence.** Differential tests compare all seven fact fields,
   parent identity, stale and repeated-stale rejection, every sequential prefix,
   old heads, and reopen. The kernel comparison records projection, receipts,
   and unresolved reservations after every commit through graph edits, source
   binding, claim, rotation, reservation, recovery, observation, safe release,
   and retry. This exposed Git's omitted `effect-release.json`; it is repaired.
   Physical identities differ and are normalized; authority references stay
   bound to their original backend. This is bounded trace evidence, not a proof
   over every possible operation sequence.

3. **Physical differences.** A shared Git remote and one shared SQLite file each
   admit exactly one competing writer. Separate SQLite copies admit two winners:
   copying a database does not create distributed authority. Child-process death
   before and after each substrate's head transition preserves the committed
   prefix. Remote Git can lose its acknowledgement after accepting a push:
   explicit rejection means no commit, recovered authoritative readback confirms
   commitment, and other failures produce `AUTHORITY_COMMIT_UNCERTAIN`.
   Git readback verifies commit, tree, and payload object hashes and rejects
   missing objects, merge histories, parent discontinuity, and malformed facts.
   Neither content identity alone detects a valid rollback of the entire
   authority. Trusted remote-ref custody remains an external assumption;
   stale or restored local clones must refresh the remote before mutation.

4. **Requirement and selection.** The deployed command topology needs one durable
   CAS head across independent hosts. Git objects plus the existing remote ref
   satisfy that requirement. A SQLite service could also supply it, but no such
   service, deployment, command route, or custody boundary exists here. Creating
   those mechanisms to replace a working remote CAS would enlarge this task and
   the trusted deployment surface. Select `GitFactStore` and `GitOvercenterKernel`.
   Managed source remains Git, independently of the authority ref. Observation
   stays in provider verifiers; the relational SQL architecture stays a model.

5. **Rejected mechanisms.** Delete production `SqliteFactStore` and its convenience
   kernel. The object/head decomposition adds object publication, replication,
   and missing-object recovery while still needing remote head CAS; no current
   requirement needs that split. Keep the historical experiment, not a new
   production store. SQLite survives only under `test/fixtures` as an independent
   transactional/digest oracle. Its demonstrated value is catching a real field
   omission in the live backend, not offering a runtime backend choice.

6. **Cutover.** Existing production authority already uses Git, so no production
   substrate migration or identity remapping occurs. Preserve every existing Git
   commit and the legacy empty initialization; do not dual-write. Scratch-only
   computation and latency proofs now create Git stores and transport repository
   directories. Their prior disposable SQLite artifacts are not live authority.
   Read-only replay of the inspected production ledger fails with
   `CLAIM_WHILE_NOT_READY` under both the starting implementation and this change.
   This pre-existing semantic history problem is not rewritten by a storage ADR.

7. **Deleted surface and verification.** Remove `src/storage/sqlite.ts` and
   `src/authority/kernel.ts`; bind `DurableFactStore` in physics to the actual Git
   implementation. Promote SQLite kernel invariants into the live durable-kernel
   suite and remove its backend-specific schema assertions. Provider-effect tests
   exercise the live store. The test oracle has no production import. Use
   `npm run test:storage`, `npm test`, `npm run typecheck`, and
   `npm run check:tcb -- --baseline <fresh-main>`; retain distributed handoff,
   chaos, and decomposition evidence. Exact-head TCB policy is unchanged.
   Production `src/` shrinks by 232 lines. The overall patch grows because the
   independent oracle and hostile/differential verification remain outside the
   production trusted surface. Accepted-scope TCB analysis conservatively retains
   deleted implementations in its scratch comparison, never counting them as
   zero trust or replacing surviving candidate dependencies with baseline code.

Overcenter has one authoritative durable fact architecture. SQLite is an
independent test oracle, not an alternate production authority.
