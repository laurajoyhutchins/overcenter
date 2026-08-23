# Portfolio Control Plane source materialization

GitHub repository `laurajoyhutchins/portfolio-control-plane-github-app`, branch `main`, is the sole authority for repository source.

Hatchable project `proj_I6FSm85xrY7T` is a runtime projection. Runtime differences are drift to diagnose and repair from GitHub. They never authorize a write from Hatchable back to GitHub.

## Architecture

```text
GitHub main authority
       |
       v
observe exact Git head -> plan deterministic materialization -> fetch verified Git blobs -> stage runtime writes/deletes -> verify -> deploy
       |
       v
Hatchable runtime projection
```

The deterministic protocol lives in `lib/source-sync.js`. It owns synchronized path selection, exact-coordinate preconditions, Git blob identity, pull/materialization planning, runtime drift diagnostics, and postcondition verification. It performs no network calls and holds no credentials.

Authenticated adapters only observe GitHub and apply the derived runtime projection. No source-sync operation publishes repository source from Hatchable to GitHub.

## Materialized source surface

These GitHub-backed paths may be materialized into Hatchable:

- `api/**`
- `lib/**`
- `mcp/**`
- `pages/**`
- `public/**`
- `migrations/*.sql`
- `hatchable.toml`
- `package.json`
- `seed.sql`

Repository-only paths such as `.github/**` remain GitHub-only and are not materialized into Hatchable. Root `AGENTS.md` is not a Hatchable source file.

## Materialization workflow

1. Observe the exact GitHub `main` head and the current Hatchable project version/source projection.
2. Require those observations to match the caller's expected coordinates before planning.
3. `planPullSync` compares GitHub authority with the runtime projection and reports missing, stale, or content-mismatched runtime paths.
4. Fetch complete UTF-8 text for exactly the planned Git blobs.
5. `materializePullPlan` verifies every fetched blob SHA and derives deterministic Hatchable writes, deletes, and the complete target manifest.
6. Stage only the derived runtime changes.
7. Re-observe and verify the complete draft before deployment.
8. Run the project dry-run deployment gate when available.
9. Recheck the GitHub head and Hatchable version immediately before deployment.
10. Deploy and verify the resulting runtime manifest against the GitHub-derived target records.

A no-op performs no runtime mutation.

## Drift and recovery

Runtime projection drift is explicit evidence, not a competing source version.

`planPullSync` and `verifyHatchableProjection` report runtime drift such as:

- a GitHub-authoritative path missing from the runtime;
- a stale runtime path that is no longer present in the GitHub source surface;
- runtime content whose Git blob identity differs from GitHub authority.

Recovery is deterministic rematerialization from the current fenced GitHub head. A detected runtime difference never creates, authorizes, or implies a GitHub mutation.

## Concurrency

GitHub is observed at an exact commit before materialization and rechecked before deployment. A moved GitHub head invalidates the materialization attempt.

Hatchable does not expose a project-wide compare-and-swap over draft source. Materialization therefore uses the observed project version plus complete-draft verification before staging, after staging, after dry-run, and immediately before deploy. Any observed runtime change invalidates the attempt rather than being merged implicitly.

## Authentication boundary

No source-sync credential exists in the Portfolio Control Plane project.

The GitHub adapter uses the already authorized GitHub surface to read the exact authoritative commit and blobs. The Hatchable adapter uses the caller's authenticated Hatchable connection to stage and deploy the derived runtime projection. Credentials remain owned by those platforms and do not cross into `lib/source-sync.js`.

Historical in-app source-sync routes and reverse-publication concepts are not part of the current architecture.

## Governing rule

Agents author or integrate authoritative repository source in GitHub. Deterministic software derives, materializes, diagnoses, and verifies the Hatchable runtime projection from that authority. Runtime state does not become repository authority merely because it differs from GitHub.
