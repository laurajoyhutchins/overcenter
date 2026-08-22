# Source Sync External-Adapter Design

## Decision

Do not give the Portfolio Control Plane GitHub App a Hatchable management credential so it can mutate its own hosting project.

Keep source synchronization deterministic, but move authority access to external authenticated adapters. The source-sync module becomes a pure planner/verifier with no network access and no credentials.

## Boundaries

`lib/source-sync.js` owns:

- fixed project/repository/branch coordinates;
- synchronized path classification;
- SHA-256 source manifests;
- canonical Git blob SHA-1 calculation;
- exact Hatchable-version and GitHub-head preconditions;
- push create/update/delete planning;
- pull fetch/delete planning;
- fetched-blob verification and target materialization;
- Git and Hatchable postcondition verification.

External adapters own:

- Hatchable `get_project`, file reads/writes/deletes, dry-run, deploy, deployment verification;
- GitHub head/tree/blob reads;
- exact-head GitHub mutation through the existing control-plane changeset transaction or an equivalent authenticated connector.

## Removed design

The running app must not call Hatchable's management API using a stored bearer token. Remove the self-management client, its project-secret declaration, the push/pull application routes, and their MCP tools. Remove command-response and orchestration-journal vocabulary that described those routes as canonical in-app commands.

## Safety

Push uses GitHub expected-head compare-and-swap and then verifies both authorities.

Pull snapshots Hatchable before staging, verifies the complete staged tree, dry-runs, rechecks both coordinates immediately before deploy, and restores the snapshot on any pre-deploy failure. A deployed but unverified result is reported as indeterminate and is never silently retried as a fresh mutation.

## Rationale

This keeps authority where it already exists. ChatGPT's connected Hatchable application can manage Hatchable through OAuth without exporting that authority into application code. The GitHub side already has bounded mutation machinery. A new account-scoped credential would expand the application's authority solely to let it mutate itself, which is unnecessary.