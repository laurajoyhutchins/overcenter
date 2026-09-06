# GCP Cloud Run + Cloud SQL migration

## Goal

Move Overcenter's deployable runtime from Hatchable to GCP without making GCP part of the semantic kernel. Cloud Run is the current compute adapter and Cloud SQL PostgreSQL is the current database implementation; Overcenter continues to depend on ordinary HTTP/runtime and PostgreSQL boundaries.

## Provisioned landing zone

Deployment coordinates are host configuration, not semantic inputs:

- GCP project: `project-6b810532-a302-48dc-b56`
- region: `us-west1`
- Cloud SQL instance: `overcenter-postgres`
- Cloud SQL connection: `project-6b810532-a302-48dc-b56:us-west1:overcenter-postgres`
- database: `overcenter`
- database user: `overcenter`
- runtime service account: `overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com`
- database password secret: `overcenter-db-password`

The Cloud SQL public IP is not an application coordinate. Cloud Run connects through the authenticated Cloud SQL integration and the `/cloudsql/...` Unix socket.

## Phase 1: shadow runtime

`./scripts/gcp/deploy-shadow.sh` deploys a private service named `overcenter-shadow` by default.

The shadow deployment:

1. builds the portable TypeScript runtime from source;
2. runs under the dedicated Overcenter runtime service account;
3. receives PostgreSQL configuration through ordinary `PG*` environment variables;
4. receives the database password from Secret Manager;
5. mounts the Cloud SQL instance through the Cloud Run integration;
6. keeps minimum instances at zero and maximum instances at one;
7. remains unauthenticated-public-access disabled; and
8. performs an authenticated `/health` request whose success requires `SELECT 1` against Cloud SQL.

A successful shadow deployment proves the target runtime can start and reach the target database. It does **not** prove that production Overcenter state has migrated, and it does not authorize a production cutover.

## Phase 2: authoritative database migration

Do not copy live state piecemeal and do not reconstruct state from GitHub or Linear. Hatchable's PostgreSQL-backed execution state contains authority-bearing runs, leases, checkpoints, proof state, operation certainty and receipts.

The migration sequence is:

1. **Freeze source mutation.** Stop writers and scheduled advancement at the Hatchable authority boundary. Record the exact freeze point.
2. **Prove quiescence.** Confirm no source-side write can race the export. Resolve or explicitly preserve any unresolved operation certainty before moving authority.
3. **Create a consistent PostgreSQL export.** Use one transactionally consistent dump/snapshot of the authoritative source database.
4. **Restore into Cloud SQL.** Restore schema and data without starting Overcenter writers against the target.
5. **Generate source and target manifests.** Run `node scripts/postgres-state-manifest.mjs` against each database with the same exclusions. The host-local `overcenter_runtime_deployments` table may be excluded because it is shadow-runtime state, not migrated execution authority.
6. **Compare manifests.** The table set, schema hashes, row counts and row-content hashes must match exactly for all authority-bearing tables.
7. **Inspect recovery-sensitive state.** Explicitly inspect unresolved operation state, active/expired leases, open runs, latest checkpoints, proof state and mutation receipts. A byte-for-byte successful copy can still contain legitimate pre-existing recovery work.
8. **Read-only target smoke.** Exercise inspection/read paths against Cloud SQL with mutations disabled.
9. **Cut over endpoint authority once.** Point canonical Overcenter traffic and scheduling to the verified GCP runtime. Do not run Hatchable and GCP as concurrent writers.
10. **Post-cutover readback.** Re-read authority through the new runtime, confirm the exact expected state, then enable ordinary advancement.
11. **Retain the source as rollback evidence.** Do not destroy the Hatchable database during initial cutover.

## Manifest acceptance rule

Migration verification is deterministic:

```text
source manifest == target manifest
  table set
  + schema SHA-256 per table
  + row count per table
  + canonical row-content SHA-256 per table
```

Any mismatch fails closed. An agent does not decide that a mismatch is "close enough."

## Current incident constraint

The Hatchable database-time quota incident can prevent the source database from being read or exported through normal runtime paths. That blocks Phase 2, not Phase 1. The shadow service and Cloud SQL landing zone can be built and verified independently while production authority remains on Hatchable.

## Rollback boundary

Before cutover, rollback is trivial because the GCP deployment is shadow-only. After cutover, rollback must preserve mutation certainty: freeze GCP writers, reconcile any operations that may have mutated after the cutover point, then restore a single authoritative writer. Never simply switch traffic back while both databases may have accepted writes.
