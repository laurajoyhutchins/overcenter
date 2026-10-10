# Provider capabilities

Overcenter treats observation, mutation, negative evidence, and settlement as separate capabilities. Support for one does not imply support for the others.

The table below reflects the production code currently in the repository.

| Resource | Observation | Mutation | Authoritative absence | Notes |
| --- | --- | --- | --- | --- |
| GitHub Pages static tree (inactive support) | Prospective certified provider/tree/served-byte readback, outside kernel settlement | Narrow explicit-lease transport; no admitted effect | No | Separate activation required; kernel rejects Pages work and live publication is unverified. |
| GitHub commit status | Certified repository/status reads | `github-commit-status/create` | No generic collection-negative proof | Writes require effect authority, a durable reservation, provider execution, and readback. |
| GitHub pull request update branch | Provider-specific GitHub reads | `github-pull-request/update-branch` | No | Supported as a narrow effect, not as general GitHub automation. |
| Kubernetes ConfigMap | ConfigMap observation with complete LIST/WATCH handling | `kubernetes-configmap/ensure` | Complete-list absence certificate | Reads and writes are bound to the admitted ConfigMap coordinate and authority identity. |
| GCP Cloud Run service | Certified REST GET | None | No | Failed or missing reads remain indeterminate. |
| GCP Cloud SQL instance | Certified REST GET | None | No | Failed or missing reads remain indeterminate. |
| GCP zonal Compute MIG | Certified REST GET | None | No | Binds zone, group identity, target size, and stability; target=0 does not prove actual VM absence. |
| GCP zonal autoscaler | Certified REST GET | None | No | Binds target MIG, min/max capacity and selected metrics; unrecognized or denied reads remain indeterminate. |

## How to read the table

A provider credential gives code access to a provider. It does not, by itself, give that code authority over Overcenter state.

The authority kernel decides whether an effect is allowed. Provider code implements or observes a specific admitted operation. Settlement depends on evidence that the active verifier understands.

That means:

- an HTTP success is not enough to settle a run;
- a missing resource is not authoritative absence unless the verifier recognizes the evidence;
- observation code does not gain mutation authority by reading;
- mutation code does not get to choose a different resource coordinate; and
- support for one resource or operation does not imply general provider support.

## GCP observation

`src/providers/gcp/certified-observation.ts` implements the shared certified GET path.

For Cloud Run, the observer validates the requested service identity, UID, generation, selected readiness fields, and the structural response slice.

For Cloud SQL, it validates project and instance identity, settings version, state, database version, backend type, connection identity, and the selected response slice.

The Cloud Run and Cloud SQL observers treat read failure and absence as indeterminate. Neither provides a mutation path.

The zonal Compute observers in `src/providers/gcp/compute-zonal-runner-pool.ts` also use the certified GET path. They bind a MIG to its project, zone and resource identity; bind an autoscaler to its exact MIG; and expose policy drift, target size and stability without granting mutation authority. The warm-pool policy assessment explicitly **does not certify actual VM absence**. That requires separate authoritative instance enumeration plus Pub/Sub and teardown evidence. A 403 or missing data is never reported as an empty pool. These observations require a dedicated narrowly permitted GCP reader; the recurring deployer intentionally lacks Compute readback permission (see #686 and #726).

## Adding provider support

New provider work should specify four things independently:

```text
resource coordinate
    |
    +-- observation
    +-- mutation
    +-- absence semantics
    +-- settlement semantics
```

Each part needs its own semantics and evidence. Do not derive one capability from the presence of another.
