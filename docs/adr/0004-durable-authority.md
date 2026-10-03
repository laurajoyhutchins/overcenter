# ADR-0004: SQLite facts, one shared authority CAS

Status: Implemented candidate; merge requires exact-head hosted evidence.
Date: 2026-09-30.

The decisive requirement is exact-head coordination between independent ephemeral
command runners. It requires a shared serialization boundary; it does not require
a central Overcenter service or a Git database on the replay hot path.

1. **Production topology.** Project advance/submit, source settlement and hostile
   evidence jobs instantiate independent kernels. Trusted command runners carry
   storage credentials; task workers receive bounded assignments and evidence
   contracts. They share `refs/overcenter/state`, separately from managed source.
   `KernelCore` centralizes admission rules, not deployment ownership.

2. **Logical equivalence.** Differential traces compare every fact field, parent,
   admitted/rejected operations, project projection, receipts and unresolved
   reservations after each prefix. Traces include graph updates, source binding,
   claim, execution rotation, reservation, release, observation, integration/retry,
   stale/repeated stale writers, old heads, reopen and sequential history. The
   omitted Git effect-release field was a bug and is repaired. The independent
   SQLite-head oracle normalizes physical identities. This is bounded hostile
   trace evidence, not exhaustive mathematical equivalence.

3. **Physical distinction.** Two processes sharing SQLite have one CAS winner;
   separate SQLite authority rows admit two winners. Production therefore has no
   SQLite head row. Separate sandboxes maintain independent SQLite object tables
   and contend through one remote Git ref CAS. Crash tests exercise both sides of
   authority advancement. Lost remote acknowledgements require authoritative
   recovery; unconfirmed results remain `AUTHORITY_COMMIT_UNCERTAIN`. An unavailable
   remote cannot be replaced by a cached local authority decision.

4. **Selection.** `SqliteFactStore` is the sole production DurableFactStore, and
   `OvercenterKernel` the sole wrapper. SQLite stores verified immutable Git-format
   bytes and serves history reconstruction/replay, including warm reopened history
   with zero Git object reads. `GitAuthorityJournal` only constructs/publishes
   immutable objects, transports missing objects, and performs ref CAS. No central
   application service, shared database filesystem, dual write protocol or alternate
   authority election exists. Provider observation and source integration retain
   their existing boundaries; relational SQL remains the architecture model.

5. **Rejected alternative.** Delete the complete production GitFactStore and
   GitOvercenterKernel paths. Their history reconstruction through Git subprocesses
   is unnecessary once verified bytes are locally materialized. Independent local
   SQLite heads are insufficient for cross-host exclusion. A central SQLite service
   adds a deployment owner that current workflows do not need. Test-only direct Git
   transport and independent transactional SQLite head oracles remain to exercise
   substrate failures and catch fact-field omissions; neither is a runtime option.

6. **Integrity and recovery.** Every read hashes commit, tree and payload bytes
   against the retained physical identity, then verifies linear parent traversal.
   Tampered caches fail closed. Missing caches are reconstructed from immutable
   transport. Restoring an old cache cannot restore an old authority head. Verified
   cached replicas may remain readable while authority is unavailable; mutations
   still require remote CAS. A valid rollback of the shared remote itself cannot be
   detected from object hashes alone: remote-ref custody is an explicit trust
   assumption, unchanged from production. Recovery never mistakes an existing
   ancestor for proof of an ambiguously acknowledged rollback.

7. **Cutover and deleted surface.** Every existing fact, parent, reservation and
   receipt retains its exact Git identity. Cutover only changes local materialization;
   no authoritative history migration or second head is created. Reopen/deletion
   recovery is idempotent. Remove the duplicate Git kernel/store contract and unused
   history APIs; bind physics to the actual SQLite composition. Retain source Git,
   exact revision and TCB gates, distributed handoff/chaos and independent oracles.
   Materialization adds SQLite to each sandbox, not to task-worker write privileges.

Overcenter has one authoritative durable fact architecture: SQLite materialization
plus one shared CAS head. Git and SQLite have non-overlapping production duties.
