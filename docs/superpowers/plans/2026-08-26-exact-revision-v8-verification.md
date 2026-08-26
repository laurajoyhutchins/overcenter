# Exact-revision Hatchable V8 verification implementation plan

**Goal:** Replace manual Hatchable verification-project choreography with one deterministic exact-revision V8 verification operation.

**Architecture:** Keep `lib/exact-revision-verification.js` as the attribution contract. Add a repository-side driver that reconciles an exact checked-out source tree into one dedicated Hatchable verifier, proves the immutable deployed manifest, runs canonical regressions, and emits the existing receipt shape. A serialized GitHub Actions job provides the real Hatchable MCP adapter.

## Task 1: Driver contract

1. Add a Node test for successful exact-source materialization, stale-file deletion, deployment attribution, canonical regression execution, and receipt shape.
2. Run it before the driver exists and record RED.
3. Implement the smallest dependency-injected core to pass.
4. Add fail-closed tests for malformed SHA, post-deploy source mismatch, wrong deployment version, and regression failure.

## Task 2: Local exact-source adapter

1. Add tests that only synchronized deployable paths are selected from the checked-out Git tree.
2. Require `git rev-parse HEAD` to equal the requested 40-character SHA.
3. Read complete UTF-8 bytes and SHA-256 each synchronized path.

## Task 3: Hatchable MCP adapter

1. Use the supported `hatchable-mcp` stdio server with `HATCHABLE_TOKEN`; do not hand-roll account HTTP endpoints.
2. Use list-files, write-files/delete-file, deploy, get-deployment, and run-function tools only.
3. Normalize MCP tool results in one place and reject tool-level errors.
4. Never target the production project coordinate.

## Task 4: Serialized verification workflow

1. Add a dedicated exact-revision V8 job/workflow with one fixed concurrency group and `cancel-in-progress: false`.
2. Require an exact commit SHA and check out that SHA.
3. Install the current stable MCP client package ephemerally in the runner; do not add runtime npm dependencies to Overcenter.
4. Read `HATCHABLE_TOKEN` from Actions secrets and verifier project coordinate from repository configuration.
5. Run the driver and preserve its JSON receipt as build evidence.
6. Fork PRs without secrets must not gain a privileged `pull_request_target` path.

## Task 5: End-to-end proof

1. RED: run the contract test before production driver code exists.
2. GREEN: run repository-static tests after implementation.
3. Execute the driver against the dedicated isolated verifier using an exact candidate SHA.
4. Require post-deploy file hashes to match the candidate and `/api/verification/regressions` to report zero failures.
5. Confirm production Overcenter deployment was not changed.

## Task 6: Integration

1. Review exact head through Overcenter.
2. Integrate only after exact-head checks and isolated V8 evidence pass.
3. Settle verification with the exact revision, verifier deployment version, manifest evidence, and regression result.
