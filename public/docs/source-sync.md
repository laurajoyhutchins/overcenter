# Busbar source synchronization

Source synchronization connects exactly two authorities:

- Hatchable project `proj_I6FSm85xrY7T`
- GitHub repository `laurajoyhutchins/busbar`, branch `main`

The synchronization protocol is deterministic software. Authority-specific reads and mutations are performed by external authenticated adapters. The running Hatchable application does not authenticate back into its own management plane and does not hold a Hatchable account credential.

## Architecture

```text
Authenticated Hatchable adapter       Deterministic source-sync protocol       Authenticated GitHub adapter
(get_project/read/write/deploy)  <-->  observe -> plan -> apply -> verify  <--> (read Git/apply exact-head change)
```

The protocol implementation lives in `lib/source-sync.js`. It owns path selection, Git blob identity, exact-coordinate preconditions, diff planning, pull materialization, and postcondition verification. It performs no network calls and holds no credentials.

The adapter layer owns authority access only. A ChatGPT worker with the connected Hatchable and GitHub applications is one valid adapter host. Another client may implement the same contract later without changing synchronization semantics.

## Synchronized source surface

Hatchable-backed paths are synchronized:

- `api/**`
- `lib/**`
- `mcp/**`
- `pages/**`
- `public/**`
- `migrations/*.sql`
- `hatchable.toml`
- `package.json`
- `seed.sql`

Repository-only paths such as `.github/**` are preserved on GitHub and ignored on pull. Root `AGENTS.md` is not treated as a Hatchable source file.

## Push workflow

A push means Hatchable source becomes the desired synchronized projection on GitHub `main`.

1. The Hatchable adapter observes the current project version, source file list, and complete text of synchronized files.
2. The GitHub adapter observes the exact `main` head and recursive tree.
3. `planPushSync` requires the observed Hatchable version and GitHub head to equal the caller's expected coordinates.
4. The planner computes Git blob identities and a single create/update/delete changeset. GitHub-only paths are absent from that changeset.
5. The GitHub adapter applies the changes with the existing exact-head `github.apply_changeset` transaction. No force push is allowed.
6. Both authorities are observed again. `verifyGitProjection` must prove the synchronized Git tree equals the captured Hatchable source and the Hatchable version/source must still match the original observation.

A no-op produces no commit.

## Pull workflow

A pull means an exact GitHub `main` commit becomes the desired synchronized projection in Hatchable.

1. Both authority coordinates and current synchronized source are observed.
2. `planPullSync` identifies only changed Git blobs to fetch plus synchronized Hatchable paths to delete.
3. The GitHub adapter fetches complete UTF-8 text for exactly those planned blobs.
4. `materializePullPlan` verifies every fetched blob SHA and produces deterministic Hatchable writes/deletes plus the complete target manifest.
5. The Hatchable adapter stages writes/deletes, re-observes the full draft, and verifies it against `target_records`.
6. Hatchable `dry_run_deploy` must pass.
7. The GitHub head and Hatchable version/draft are rechecked immediately before deploy.
8. The Hatchable adapter deploys and verifies the resulting deployment manifest against the target records.
9. If any failure occurs before deployment, the adapter restores the captured Hatchable draft and verifies the restoration.

## Concurrency

GitHub mutation uses a true expected-head compare-and-swap through `github.apply_changeset`.

Hatchable currently exposes atomic multi-file writes but not a project-wide compare-and-swap over draft source. Pull therefore uses version checks plus full-draft verification before staging, after staging, after dry-run, and immediately before deploy. Any observed drift is a conflict, never an implicit merge.

## Authentication boundary

No additional source-sync credential exists in the Busbar project.

The Hatchable adapter uses the caller's existing authenticated Hatchable connection. The GitHub adapter uses an authenticated GitHub connection or the already installed Busbar GitHub App for the exact-head Git mutation. Credentials remain owned by those platforms and do not cross into `lib/source-sync.js`.

The former in-app push/pull API routes and MCP tools were removed because they could not truthfully perform the Hatchable half without giving the application an account-level management credential.

## Governing rule

Agents do not decide how to reconcile source trees. Software derives the exact changes and verifies postconditions. Agents or workers only invoke authenticated authority adapters and carry the resulting observations/effects between them.