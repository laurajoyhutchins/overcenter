# GCP IAM migration: evidence-first cutover

**Status:** source preparation, not a live IAM inventory or GCP bootstrap. This document and the readback parser never provision access, install protected workflows or authorize privileged operations.

## Exact current boundary

- Workload project: `project-6b810532-a302-48dc-b56`
- GitHub WIF provider: `projects/380435294892/locations/global/workloadIdentityPools/github/providers/overcenter`
- Existing ordinary deployer: `overcenter-deployer`. Never expand this identity to repair Compute observer 403.
- Proposed observer: `overcenter-observer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com`
- Initial observer permissions: `compute.instanceGroupManagers.get` and `compute.autoscalers.get` only. Compute `listManagedInstances` is read-only POST requiring the former permission.

## Phase 0: independently authenticated inventory

Collect readbacks of organization/folder/project ancestry and IAM allow policies; applicable IAM Deny and Principal Access Boundary policies; custom-role definitions; service-account keys, attached workload identities and impersonation edges; WIF pool/provider state, attribute mappings and conditions; resource-level IAM for Cloud Run, Cloud Build, Compute, Pub/Sub, Storage, Secret Manager and Artifact Registry where actually used; and owner/bootstrap recovery authority.

Every observation must retain exact target, authenticated principal, operation, requested IAM policy version, observed time, policy etag and evidence digest. Keep sensitive principal data out of public GitHub artifacts. Unknown hierarchy, missing readback, HTTP 403, pagination, incomplete API authority, or unsupported policy semantics => HOLD. A source script is not proof of effective IAM.

The pure `src/providers/gcp/iam-source-baseline.ts` helper normalizes only **direct allow-policy binding observations** for explicitly enumerated targets. It requires version-3 readback and etag, retains conditional grant expressions and broad direct members, and refuses missing, malformed or duplicate observations. Even when its result is `observed`, `effective_permissions_established` and `authorization_established` remain `false`. It does not retrieve GCP state, interpret conditions, expand roles, compute inherited access, evaluate Deny/PAB or certify federation trust.

## Gated migration

| Stage | Change | Gate |
| --- | --- | --- |
| 0. Baseline | Read only | Complete independently observed grant/trust/effective-authority analysis, separately from source inspection |
| 1. Observer | Separate narrowly scoped service account and WIF grant | Owner-approved exact manifest, independently read-back WIF trust and IAM, positive/negative authorization tests |
| 2. Protected readback | #746 installed via owner-authorized protected-source recovery | Exact workflow/source identity; live #747 instance census; no GCP writes |
| 3. Routine workload identities | Parallel cutovers only | Exact-head admission, verified provider effect and independent settlement per lane |
| 4. Privileged administrator | Explicitly owner-approved one-operation identity | Fresh CAS/manifest/expiry checks, separately authenticated bootstrap and readback |
| 5. Retirement | Revoke obsolete grants | No active dependencies, negative permission probes and observed policy removal |

Preserve current Pub/Sub-based MIG autoscaler as the **sole capacity actuator** through this permission migration. The live #686 cold-wake, JIT/lease, ACK, Docker/workspace teardown and physical-zero tests remain distinct from IAM inventory. Never infer absent VMs from target size zero or HTTP 403.

## Authority dependencies

- #760 tracks this migration.
- #726 defines the GCP provider contract.
- #750 is the concrete observer IAM bootstrap.
- #702 specifies owner approval.
- #746 is protected workflow source, excluded from ordinary merge admission.
- #747 certifies read-only managed-instance observation.
- #686 tracks the live runner lifecycle.

General migration authorization does **not** constitute exact-manifest approval of a privileged IAM modification. No privileged GCP mutation or existing deployer authority change is performed by this slice.
