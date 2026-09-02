# Legacy History Census Shared Contract

> **For agentic workers:** This is a normative amendment to Task 10 of `2026-09-02-telemetry-archive-retirement-readiness.md` and every census/readiness step in `2026-09-02-destructive-execution-history-retirement.md`. Read it with those plans before implementation.

**Goal:** Give Plan B and Plan C one exact database-owned source-census contract so freeze/readiness and destructive migration cannot drift into separate implementations.

## Canonical interface

Migration `062_legacy_history_retirement_control.sql` MUST define:

```sql
legacy_history_source_census() RETURNS jsonb
```

The function is the only canonical SQL implementation of the retiring-source census.

It returns one deterministically key-sorted JSON object covering exactly the 14 retiring source tables. For each source it contains:

```text
source_kind
row_count
source_identity_sha256
```

`source_identity_sha256` is SHA-256 over the source's stable, ordered source identities using the same source-identity definitions as `lib/legacy-history-backfill.js`. The aggregate `expected_source_sha256` is SHA-256 over canonical JSON of the complete returned object.

## Required consumers

These components MUST call the same helper rather than reimplementing source-census SQL:

```text
lib/legacy-history-retirement.js
Plan B freeze/readiness checks
scripts/legacy-history-retirement-postgres.test.mjs
scripts/verify-legacy-history-retirement-ready.mjs
migrations/063_retire_obsolete_execution_history.sql
scripts/retire-obsolete-execution-history-postgres.test.mjs
```

Plan B Task 10 Step 4 is therefore interpreted exactly as:

1. verify Plan A compact-authority preconditions;
2. verify no unresolved sanitizer rejection;
3. call `legacy_history_source_census()`;
4. store its returned census and canonical aggregate SHA-256;
5. set `freeze_state='frozen'` and `frozen_at` in the same transaction.

Plan C MUST call `legacy_history_source_census()` immediately before destructive retirement and compare both the returned census and aggregate digest with the frozen readiness record.

## Failure semantics

If the helper is missing, any required source table is missing before migration 063 begins, a source identity cannot be computed deterministically, or the current census differs from the frozen census, readiness/destructive migration fails closed.

No application-side fallback census is allowed. No telemetry/archive record may substitute for this comparison.

## Verification

Plan B's PostgreSQL retirement test must prove the helper returns identical bytes before and after a representative maintenance interval while the freeze triggers are enabled.

Plan C's destructive migration test must mutate the frozen source set in a fixture where guards are intentionally disabled and prove migration 063 rejects the changed census before any `DROP TABLE` executes.
