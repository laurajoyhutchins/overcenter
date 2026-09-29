# Provider capability boundaries

Provider support is intentionally asymmetric. Observation, mutation, negative evidence, and settlement authority are separate capabilities.

This table describes the production code currently present in the repository. A provider appearing here does not imply general-purpose support for that provider.

| Resource | Certified observation | Mutation path | Authoritative negative evidence | Boundary |
| --- | --- | --- | --- | --- |
| GitHub commit status | Yes, exact repository/status read machinery | Yes, `github-commit-status/create` | No generic collection-negative authority | Mutation requires kernel-minted effect authority, reservation, provider execution, and authoritative readback. |
| GitHub pull request update branch | Provider-specific GitHub reads exist | Yes, `github-pull-request/update-branch` | No | Narrow effect profile only; not a general GitHub automation surface. |
| Kubernetes ConfigMap | Yes, ConfigMap observation including complete LIST/WATCH semantics | Yes, `kubernetes-configmap/ensure` | Yes, only the recognized complete-list absence certificate | Mutation and observation are bound to the exact admitted ConfigMap coordinate and authority identity. |
| GCP Cloud Run service | Yes, certified REST GET slice | No production mutation profile | No | Observation is positive-state evidence. Read failure or absence is indeterminate. |
| GCP Cloud SQL instance | Yes, certified REST GET slice | No production mutation profile | No | Observation is positive-state evidence. Read failure or absence is indeterminate. |

## Interpretation

A provider credential is a capability, not Overcenter project authority.

The authority kernel decides whether an effect is eligible. Provider-specific code decides how to materialize or observe one admitted coordinate. Settlement requires evidence whose semantics are recognized by the active verifier.

In particular:

- an HTTP success is not automatically settlement;
- an empty or failed read is not automatically authoritative absence;
- a provider observer does not gain mutation authority by observing;
- a mutation adapter does not gain authority to choose its own coordinate;
- supporting one resource does not imply support for arbitrary operations in that provider.

## GCP observation

`src/providers/gcp/certified-observation.ts` provides the common certified GET boundary.

Cloud Run observation validates the exact requested service name, stable UID, generation identity, selected readiness/reconciliation fields, and the structural response slice. It explicitly marks negative evidence as non-authoritative.

Cloud SQL observation validates the exact project and instance identity, settings version, state, database version, backend type, connection identity, and selected structural response slice. It also marks negative evidence as non-authoritative.

These observers establish bounded facts about existing resources. They do not create, update, delete, or settle arbitrary GCP resources.

## Extension rule

Add provider support by separating:

```text
semantic coordinate
      |
      +--> observation
      +--> mutation
      +--> absence semantics
      +--> settlement semantics
```

Do not infer one capability from another. Each authority-bearing edge needs its own admitted semantics and evidence.
