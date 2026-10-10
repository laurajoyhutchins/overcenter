# Read-only GCP IAM / Workload Identity Federation census

**Status:** source-only operator. No live Google Cloud reads have been executed by this PR.

This operator makes a **fixed** series of read requests against the existing GCP project, its ancestor hierarchy, service accounts, custom roles, and GitHub Workload Identity Federation provider. It never invokes `gcloud config set`, installs credentials, creates grants, updates policies, or runs an infrastructure effect. The credential comes from the existing separately authenticated `gcloud` session.

## Private owner/admin invocation (when separately authenticated)

With a compatible Google Cloud SDK and Node 22+:

```bash
export GCP_IAM_CENSUS_OUTPUT="$(mktemp -u "$HOME/overcenter-iam-XXXXXX.json")"
node --experimental-strip-types src/providers/gcp/iam-census-cli.ts
```

Use a location outside the checked-out repository; keep this output confidential. The tool creates the file with mode `0600` and refuses to overwrite an existing path. The example `mktemp -u` creates a candidate filename without creating the file; the operator's exclusive-create flag prevents overwrite, but the output directory must also be trusted. No automatic GitHub artifact upload is allowed.

A run can exit with code 2 after safely recording incomplete readbacks (for example, the proposed observer identity not yet existing). That outcome is a **HOLD**, not evidence that a service account is absent or inaccessible.

The operator prints only an attempted/indeterminate summary. Raw IAM policies and federation mappings are written privately. Never attach this raw census to a public issue or CI log.

## Limits and next evidence

This is **not an effective-permissions report**. Seven readbacks do not account for all organization/folder policies, inherited custom roles, resource-level allow grants, IAM Deny or Principal Access Boundary evaluation, session-specific federation claims, resource-level conditions or future permission propagation.

The operator's `direct_readbacks_complete` flag means only that every enumerated command returned a JSON object, not that Google Cloud authority has been fully established. Its `effective_permissions_established`, `authority_granted`, and `independently_verified` fields are always false.

Before privileged #750 observer bootstrap: independently authenticate the owner, inspect WIF claim mappings and effective trust, build an exact resource/permission/role/principal manifest, and obtain the separate approval required by #702. A successful readback cannot itself grant authority.

This follows #760 and the direct-binding baseline in #761. The existing deployer, protected #746 workflow, runner #686 and sole Pub/Sub autoscaler remain unchanged.
