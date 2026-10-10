# Stub 03: governed Google Cloud resource effects

**Status:** design / draft PR only. This document does not authorize or implement any GCP mutation or privileged role.

**Parent:** #726; Git parent draft PR #732. **Other dependencies:** #727 and #728, #729 single-actuator lease integration, #686 live canary, #702 protected owner approval.

## First narrowly admitted effects

| Effect contract candidate | Desired outcome | Preconditions | Independent postcondition |
| --- | --- | --- | --- |
| `gcp.cloud-run-service/ensure-revision/v1` | An exact Cloud Run service serves an expected immutable image/revision under a bounded traffic policy | Exact project/location/service UID or approved absence, expected etag/generation, pinned source/image digest, configured execution identity | Read back same service, UID, generation, latest ready revision, traffic mapping and terminal readiness |
| `gcp.compute-autoscaler/ensure-policy/v1` | Existing named autoscaler retains one approved, explicit Pub/Sub metric policy and 0..1 bounds | Exact project/zone/autoscaler/MIG linkage, known current fingerprint, owner-approved policy digest | Read back exact MIG linkage, policy min/max, metric filters, cooling and autoscaler status; do not infer VM absence |
| `gcp.cloud-sql-instance/observe` (no mutation initially) | Certified database instance state remains visible | Exact project/instance coordinate | Existing certified GET, with known settings version; no provisioning or settings change |

**Explicitly forbidden first cut:** `start-vm`, `stop-vm`, `resize-mig`, `set-capacity`, arbitrary `gcloud`, arbitrary REST, blanket IAM role grant, network/firewall creation, secret material exfiltration or generic workflow dispatch.

## Admitted effect lifecycle

1. Reconstruct and lock an exact authority/source/configuration revision; fetch fresh certified provider observation and independently approved policy.
2. Pure deterministic planner calculates exact resource target, expected write set and provider preconditions. Unexpected or unobserved state leads to HOLD.
3. Existing authority kernel reserves one effect permit bound to target, allowed request digest, executor principal/permission ceiling, expiry and concurrency guard.
4. Only a provider-specific, enumerated REST mutation may execute, with exact etag/generation/fingerprint precondition. Record operation identity before considering completion.
5. For async operations, independently read the operation and final resource state; do not interpret HTTP acceptance as settlement.
6. On timeout/partial execution, reconcile the exact resource and operation. No blind retry, duplicated VM activity or unapproved rollback. Escalate as `RECOVERY_REQUIRED` if ambiguous.
7. Settle only after independent readback verifies final postcondition. Persist exact observed receipt and unresolved discrepancies in durable authority history.

## Single-actuator and identity policy

- Pub/Sub-backed existing GCE autoscaler remains **sole capacity actuator**. The autoscaler-policy contract changes only an already authorized **policy** with separately approved scope, never independently resizes the MIG.
- #728's projected demand must flow via #729's bounded lease path; zero desired demand does **not** prove zero live hosts or safe teardown.
- Ordinary deployer lacks Compute/network/Pub/Sub admin. Owner-authorized administrative changes require the separately protected #702 approval environment, exact operation-manifest digest and one-time authorization.
- IAM, Resource Manager, VPC/DNS, Service Usage enablement, Secret Manager write and Cloud SQL mutation remain **separate future** contracts, not implicit privileges of this PR.
- Any new cost/quota exposure must have explicit risk/cost policy. A budget alert is not a hard spending cap.

## Hostile acceptance and roll-out holds

- [ ] Reject wrong project/zone, forged host, mismatched service UID/MIG linkage, stale etag/fingerprint, extra metric and caller-selected arbitrary method.
- [ ] Reject modified source after approval, unauthorized principal, expired permit, changed policy, missing review and concurrent operator.
- [ ] Prove timeout/replay does not create an additional mutation; uncertain outcomes remain `RECOVERY_REQUIRED`.
- [ ] Verify postconditions independently; a 200/202 response never settles.
- [ ] Keep runtime effects dormant until exact-head source/effect tests, required owner approval and one benign live canary pass.
- [ ] Demonstrate #686's real zero -> one -> zero teardown before activating routine state-derived runner demand.

## Planned code touchpoints (not changed by this stub)

`src/effect-adapter.ts`, `src/providers/semantic-registry.ts`, `src/providers/effect-dispatch.ts`, resource-specific `src/providers/gcp/` effect/readback files, adversarial `test/gcp-*.test.ts`, and `docs/provider-capabilities.md`. Start with one effect in one follow-up PR; do not add a generic GCP mutation capability.
