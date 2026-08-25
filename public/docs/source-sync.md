# Busbar source materialization

GitHub is the sole authority for Busbar repository source. A Hatchable deployment is a derived runtime projection of an exact GitHub repository revision.

Deployment coordinates are installation-owned inputs, not constants in Busbar source. An adapter supplies:

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
                                                Hatchable runtime projection
```

The deterministic protocol lives in `lib/source-sync.js`. It owns synchronized path selection, coordinate validation, exact-revision fencing, Git blob identity, materialization planning, runtime drift diagnostics, and postcondition verification. It performs no network calls and owns no credentials.

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
- `package.json` when present
- `seed.sql` when present

Repository-only paths such as `.github/**`, `LICENSE`, `SECURITY.md`, and repository development scripts remain GitHub-only unless explicitly added to the runtime source contract.

## Materialization workflow

1. Observe the exact authoritative GitHub head and current Hatchable runtime version/source projection.
2. Supply the deployment coordinates and expected observations to `planPullSync`.
3. Fail closed if either GitHub or Hatchable moved after observation.
4. Compare GitHub authority with the runtime projection and derive missing, stale, or mismatched paths.
5. Fetch complete UTF-8 text for exactly the planned Git blobs.
6. Verify each fetched blob against its planned Git blob SHA.
7. Stage only the derived runtime writes and deletes.
8. Re-observe and verify the complete draft before deployment.
9. Recheck GitHub head and Hatchable version immediately before deployment.
10. Deploy and verify the resulting runtime manifest against the GitHub-derived target records.

A no-op performs no runtime mutation.

## Drift and recovery

Runtime projection drift is evidence that the derived runtime is stale. It is not a competing source version.

`planPullSync` and `verifyHatchableProjection` report conditions such as:

- a GitHub-authoritative path missing from the runtime;
- a stale runtime path no longer present in GitHub;
- runtime content whose Git blob identity differs from GitHub authority.

Recovery is deterministic rematerialization from a freshly fenced GitHub revision. A runtime difference never creates, authorizes, or implies a GitHub mutation.

## Authentication boundary

`lib/source-sync.js` holds no source-sync credential. The GitHub adapter uses an authorized GitHub read surface; the Hatchable adapter uses the caller's authorized deployment surface. Credentials stay with those adapters and never become source-materialization facts.

## Governing rule

Agents and developers author repository source in GitHub. Deterministic software derives, materializes, diagnoses, and verifies runtime source from that authority. Hosting state does not become repository authority merely because it differs from GitHub.
