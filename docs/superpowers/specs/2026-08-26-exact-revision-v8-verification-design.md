# Exact-revision Hatchable V8 verification design

## Goal

Turn the manual candidate-verification project choreography into deterministic software. A caller supplies a GitHub repository and exact 40-character commit SHA. Overcenter materializes that source into one dedicated isolated Hatchable verification runtime, proves the deployed source matches the requested revision, runs the canonical V8 regression endpoint, and emits exact-revision evidence.

## Authority

- GitHub remains authoritative for repository content and revision identity.
- Overcenter remains authoritative for orchestration and verification attribution.
- Hatchable is execution substrate only. The verifier runtime is never a source authority.
- Production Overcenter is never mutated by candidate verification.

## Shape

The repository owns a deterministic driver with two seams: an exact-source provider and a Hatchable runtime adapter. The core driver validates coordinates, computes the desired synchronized source manifest, reconciles that manifest into one preconfigured verifier project, deploys, reads the immutable deployment manifest back, rejects any mismatch, invokes `/api/verification/regressions`, and returns an `exact-revision-verification-v1` receipt.

A GitHub Actions job supplies the real adapters. It checks out the exact candidate revision and talks to Hatchable through the supported MCP transport. Workflow concurrency serializes all uses of the single verifier project so two candidates cannot overwrite each other.

## Isolation lifetime

Do not create a Hatchable project per candidate. Reuse one dedicated verification runtime. Hatchable currently exposes project creation/forking but no corresponding ephemeral-project cleanup primitive, so fork-per-candidate would institutionalize leaked project state.

The verifier database is therefore persistent. This gate proves exact-source behavior in Hatchable's V8 runtime, not fresh-database migration semantics. Real Postgres and provider-boundary integration remains tracked by GitHub issue #13.

## Fail-closed conditions

Verification fails if the repository or revision is malformed, the checked-out source is not the requested SHA, the verifier project is unavailable, source reconciliation is ambiguous, the deployment version is not the deployment just created, any synchronized file hash differs after deploy, the canonical regression endpoint cannot run, or any regression fails.

## Secret boundary

Hatchable credentials live only in the GitHub Actions secret store. The verifier project coordinate is configuration, not authority. Neither credential values nor raw authorization material may appear in repository source, receipts, logs, or artifacts.

## Future evolution

If Hatchable adds a true disposable preview-runtime primitive, only the runtime adapter lifecycle changes. The exact-revision verification contract and receipt remain stable.
