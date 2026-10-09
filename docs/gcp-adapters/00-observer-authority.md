# Stub 00: independent Google Cloud observer authority

**Status:** design / draft PR only. No IAM configuration, service-account creation, API enablement or live GCP call is implemented here.

**Parent:** #726. **Depends on:** #727 certified Compute observations, #702 protected approval, #686 live readback expectations.

## Why this is first

The owner-operated readback after #724 failed with HTTP 403 for `compute.instanceGroupManagers.get`. Expanding the ordinary `overcenter-deployer` principal into Compute, Pub/Sub or network admin is **not** the fix.

## Adapter boundary

- Identity coordinate: exact GCP project, workload identity provider, allowed repository/revision/environment, service-account identity and permission ceiling.
- Read-only observer can fetch certified MIG, autoscaler and eventually relevant instance/Cloud Run/Pub/Sub state.
- Permissions must be justified per operation: start with `compute.instanceGroupManagers.get` and `compute.autoscalers.get`, adding separately justified read capabilities only. Never grant general Compute admin.
- Use short-lived federation; keep observer, deployer and owner-authorized administrator distinct.
- Service Usage adapter initially observes which required APIs are enabled; **enabling** an API is an owner-approved administrative effect, not a side effect of reading.
- Record exact queried project/zone/name, identity used, API operation/schema, UTC timestamp, successful response slice or explicit `indeterminate`, and source revision.
- A 403, timeout or missing field does not prove absence or settled infrastructure.
- Return machine-readable readback receipts to the approved operator route without Cloud Shell. Credentials and bearer tokens must not appear in durable receipts.

## Acceptance / hostile cases

- [ ] Produce an explicit read-only permission manifest linked to exact API methods and resource targets.
- [ ] Verify federation trust binds the intended repository, protected workflow and approved identity.
- [ ] Reject wrong project/zone/resource, observer impersonation, broadened role and stale readback.
- [ ] Reject any request that tries to perform a mutation with observer credentials.
- [ ] Read-only workflow records independent signed/provenance-bound readbacks; zero VM status requires instance enumeration, not just target size.
- [ ] Capture one live, owner-authorized readback after permission setup and label observed outcomes accurately.
- [ ] Exact-head Merge gate and independent protected-source admission pass before merge.

## Planned implementation touchpoints

`src/providers/gcp/certified-observation.ts`, existing #727 Compute observers, tightly scoped workflow in `.github/workflows/`, `docs/provider-capabilities.md`, and hostile `test/gcp-*.test.ts`. Do **not** add a second HTTP authority mechanism or any registered GCP effect in this PR.
