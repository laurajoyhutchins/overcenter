# Stub 02: certified build and artifact evidence

**Status:** design / draft PR only. No changes to deployments, CI workflows or artifact retention have been made.

**Parent:** #726; Git parent draft PR #731. **Other dependencies:** #727 certified GCP reads, #702 protected admin approval for new permissions, #686 infrastructure canary as applicable.

## API adapters

| API | Read-first target | Bound effect to implement only when separately admitted | Evidence / finality |
| --- | --- | --- | --- |
| Cloud Build | build ID, project, region/global location, build configuration source digest | submit one certified build from immutable inputs | Read actual build terminal status, builder identity, image digest, execution and substitutions; operation response is not completion |
| Cloud Storage | bucket/object/generation | immutable receipt/object publication with create-only or generation-match precondition | Read generation, content hash/CRC32C and metadata; never use object listing to infer source identity |
| Artifact Registry | repository/package/version/image digest | optional immutable image promotion under a known digest | Read digest/tag mapping and repository identity; mutable tag alone is not identity |
| Cloud Logging | exact log query window/resource/job correlation | none in first cut | Logs are supporting observations, not sole postcondition evidence |
| Cloud Monitoring | exact metric name/resource/time window | none in first cut | Partial/delayed metric series cannot prove negative facts |

## Core contracts

- All observations are bound to exact GCP project, region and resource identities and the correct API method/schema version; unrecognized bodies remain `indeterminate`.
- Cloud Build request must bind exact source tree/commit/configuration digest and build substitutions. Response to submission must not settle the build.
- Artifact receipt must record source head, selected policy digest, producer execution identity, object generation and independently verified object bytes/hash. Provider metadata and stored receipt must agree.
- On ambiguous success, timeout or concurrent writer, independently read the exact build/object before any permitted retry. Do **not** submit a duplicate build or overwrite an object without proven preconditions.
- Treat Cloud Storage CRC32C and content digest as distinct verifications. Do not infer correctness from the upload's HTTP success or self-declared metadata.
- Observational Logging/Monitoring never grants write authority or pretends to prove completed teardown or provider absence.

## Acceptance / hostile cases

- [ ] Reject wrong project, regional endpoint, bucket, registry repo and build ID.
- [ ] Reject source movement, altered substitutions, untrusted result digest and mutable tag substitution.
- [ ] Reject duplicate build after timeout until prior operation is reconciled.
- [ ] Fail closed on incomplete/incorrect CRC32C, stale generation, precondition failure and unexpected object metadata.
- [ ] Distinguish build submitted, running, failed, cancelled and successful with independent readback.
- [ ] Keep logs and metrics supplementary; missing log entry does not imply operation absence.
- [ ] Pass exact-head Merge gate, independent hostile tests and live bounded readback before claiming support.

## Planned implementation

Resource-specific certified observation and postcondition files under `src/providers/gcp/` using existing `certified-observation.ts`; then narrowly registered effects under the existing admission registry **only** after a separate approved operation contract. Provider receipts remain typed and durable; do not add a generic GCP SDK or blanket deployer identity.
