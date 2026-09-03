# Overcenter source materialization

GitHub is the sole authority for Overcenter repository source. A Hatchable deployment is a derived runtime projection of an exact GitHub repository revision.

Deployment coordinates are installation-owned inputs, not constants in Overcenter source. An adapter supplies:

- the Hatchable project identifier;
- the authoritative GitHub `owner/repo` coordinate;
- the GitHub branch;
- the expected and observed Git commit SHA;
- the expected and observed Hatchable runtime version.

## Architecture

```text
GitHub repository authority
          |
          v
observe exact head -> plan deterministic materialization -> fetch verified blobs
          |                                                |
          +---------------- exact-coordinate fence --------+
                                                           v
                                  source writes/deletes + generated receipt
                                                           |
                                                           v
                                                Hatchable deployment N+1
                                                           |
                                                           v
                                        immutable deployment manifest
                                                           |
                                                           v
                                      verify receipt + source manifest
                                                           |
                                                           v
                                           verified runtime projection
```

The deterministic protocol lives in `lib/source-sync.js`. It owns synchronized path selection, coordinate validation, exact-revision fencing, Git blob identity, materialization planning, generated receipt evidence, runtime drift diagnostics, and postcondition verification. It performs no network calls and owns no credentials.

Authenticated adapters observe GitHub and apply the derived runtime projection. No source-sync operation publishes repository source from Hatchable to GitHub.

## Materialized source surface

These GitHub-backed paths may be materialized into Hatchable:

- `api/**`
- `lib/**`
- `mcp/**`
- `pages/**`
- `public/**`
- `migrations/*.sql`
- `hatchable.toml`
- `seed.sql` when present

Root `package.json` is repository/developer tooling for building and testing Overcenter, so it remains GitHub-only and is not Hatchable runtime package metadata. Repository-only paths such as `.github/**`, `LICENSE`, `SECURITY.md`, and repository development scripts likewise remain GitHub-only unless explicitly added to the runtime source contract.

`public/.overcenter/source-materialization.json` is generated runtime evidence, not GitHub-authoritative source. `isSyncableSourcePath` excludes it from the source manifest. A materialized plan emits this receipt write automatically so an adapter cannot complete the normal plan while accidentally omitting the deployment proof artifact.

## Materialization receipt

The generated `source-materialization-receipt-v1` binds one planned runtime deployment to:

- the Hatchable project;
- the GitHub repository and branch;
- one exact 40-character GitHub head SHA;
- the observed base Hatchable version;
- the immediate next Hatchable deployment version;
- the SHA-256 of the complete synchronized-source manifest;
- the synchronized source path count.

The receipt contains no credential or capability material. It is deterministic evidence describing what the adapter intends to deploy and what the immutable deployment record must later prove.

## Materialization workflow

1. Observe the exact authoritative GitHub head and current Hatchable runtime version/source projection.
2. Supply the deployment coordinates and expected observations to `planPullSync`.
3. Fail closed if either GitHub or Hatchable moved after observation.
4. Compare GitHub authority with the runtime projection and derive missing, stale, or mismatched paths.
5. Fetch complete UTF-8 text for exactly the planned Git blobs.
6. Verify each fetched blob against its planned Git blob SHA.
7. Materialize the target source records. The plan automatically adds the generated receipt write at `public/.overcenter/source-materialization.json`.
8. Stage only the derived runtime source writes, deletes, and generated receipt.
9. Re-observe and verify the complete draft before deployment.
10. Recheck GitHub head and Hatchable version immediately before deployment.
11. Deploy exactly once to the receipt's immediate target Hatchable version.
12. Read that immutable Hatchable deployment manifest, not the mutable project workspace.
13. Call `verifySourceMaterializationDeployment` with the receipt, freshly observed GitHub head, exact deployed version, and immutable deployment manifest.
14. Classify the deployment as a verified runtime projection only when verification returns `ok: true`.

A no-op performs no runtime mutation and therefore emits no new deployment receipt.

## Verification invariant

A Hatchable deployment may be physically live without being verified source state.

Overcenter MUST NOT classify a deployment as a verified projection of GitHub until all of the following are true:

- the observed GitHub head still equals the receipt's exact head;
- the observed deployment version equals the receipt's exact target version;
- the immutable deployment contains the exact generated receipt bytes;
- the immutable synchronized-source manifest hashes to the receipt's target manifest SHA-256;
- the synchronized source path count matches the receipt.

Verification is against the immutable deployment record so later Hatchable workspace edits cannot retroactively change what a prior deployment proved. Mutable workspace state is useful for planning the next materialization, but it is never evidence that a previous deployment matched GitHub.

## Drift and recovery

Runtime projection drift is evidence that the derived runtime is stale. It is not a competing source version.

`planPullSync` and `verifyHatchableProjection` report conditions such as:

- a GitHub-authoritative path missing from the runtime;
- a stale runtime path no longer present in GitHub;
- runtime content whose Git blob identity differs from GitHub authority.

`verifySourceMaterializationDeployment` additionally rejects stale GitHub authority, an unexpected Hatchable deployment version, a missing or altered receipt, synchronized-source manifest drift, and synchronized path-count drift.

Recovery is deterministic rematerialization from a freshly fenced GitHub revision. A runtime difference never creates, authorizes, or implies a GitHub mutation. Concurrent or subsequent Hatchable workspace edits may remain as unverified work in progress, but they cannot become repository authority and cannot satisfy verification for an earlier deployment.

## Authentication boundary

`lib/source-sync.js` holds no source-sync credential. The GitHub adapter uses an authorized GitHub read surface; the Hatchable adapter uses the caller's authorized deployment surface. Credentials stay with those adapters and never become source-materialization facts.

## Governing rule

Agents and developers author repository source in GitHub. Deterministic software derives, materializes, diagnoses, and verifies runtime source from that authority. Hosting state does not become repository authority merely because it differs from GitHub.
