# Bounded observer IAM access diagnostics

This is a source-only diagnostic slice for #760 and #750; no live GCP API access or IAM mutation is wired.

The pure evaluator describes four fixed tuples for `overcenter-observer`: the required MIG and autoscaler reads plus two representative dangerous mutations that must not be granted. A future separately authenticated IAM auditor may evaluate them through [Google Policy Troubleshooter v3beta](https://docs.cloud.google.com/policy-intelligence/docs/reference/policytroubleshooter/rest/v3beta/iam/troubleshoot). The v3beta response includes allow, deny and Principal Access Boundary evaluation.

Unlike Compute `testIamPermissions`, which tests **the calling identity**, Policy Troubleshooter evaluates a specified service-account principal against a resource and permission. Neither a successful policy evaluation nor a read-only request certifies an actual runner VM readback.

Every response is bound to its exact principal/resource/permission, and unknown states (`UNKNOWN_INFO`, `UNKNOWN_CONDITIONAL`) remain HOLD. Unexpected write access or absent required read access requires review. An unsupported resource or permission query also remains HOLD, rather than rewriting the target to a broader project scope.

The resulting `sample_matches` state is intentionally not named compliant or verified. Four sampled decisions cannot establish the complete privilege ceiling. `authorization_granted`, `full_permission_ceiling_verified` and `live_resource_readback_established` are **always false**. Live #750 bootstrap still requires independent WIF readback, exact owner-approved manifest, negative impersonation tests and actual #746 resource observation before activation.

No production read transport, protected workflow changes, IAM writes, runtime role expansion, Pub/Sub actuator changes or owner approval claims are included in this PR.
