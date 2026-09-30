# Source layout

The source tree is grouped by responsibility and authority.

```text
src/
├── analysis/       static analysis and runtime-reachability inspection
├── architecture/   architecture queries, reconciliation, and change planning
├── authority/      project truth, admission, replay, recovery, and reuse
├── cli/            operator command entrypoints
├── evidence/       system evidence, hostile-evidence obligations, and evidence storage
├── graph/          dependency topology and semantic identity
├── observation/    external-state observation and evidence interpretation
├── execution/      authorized computation, confinement, and executor transport
│   ├── executor/      Go physical computation executor
│   ├── confinement/   Rust native worker-confinement substrate
│   └── worker-client/ portable untrusted assignment client
├── providers/      provider APIs and resource semantics
├── source/         source proposal, verification, and integration
├── storage/        durable fact-store implementations
├── generated/      checked generated runtime artifacts
├── model.ts        shared public data model
├── semantics.ts    cross-provider settlement and effect semantics
├── digest.ts       canonical hashing
├── structural-schema.ts
└── validation.ts   shared deterministic validation
```

## Ownership

Directory boundaries describe what a module is allowed to decide.

- `analysis/` inspects code and effect relationships. Its output is evidence, not authority.
- `architecture/` queries and reconciles the SQL architecture model. See [the relational architecture model](../architecture/README.md).
- `authority/` derives and changes Overcenter project truth from admitted definitions and durable evidence.
- `cli/` exposes the supported `project.advance` and `project.submit` entrypoints.
- `evidence/` materializes and stores evidence used by verifiers and authority transitions.
- `graph/` owns dependency topology and semantic identity, not settlement.
- `observation/` reads and interprets external state.
- `execution/` performs already-authorized work and returns attempt evidence.
- `providers/` owns provider-specific APIs and resource semantics.
- `source/` owns the source-change proposal, broker, verification, and exact-base integration path. See [the source-change protocol](../docs/source-change-protocol.md).
- `storage/` persists durable facts without defining authority policy.

Root source files are reserved for shared primitives.

Provider credentials are capabilities, not project authority. A provider write or read can affect project truth only after Overcenter has established the relevant identity, authorization, observation, and postcondition. See [provider capabilities](../docs/provider-capabilities.md).

The former flat `src/` layout has no compatibility barrels. Callers import canonical paths directly, so stale imports fail in compilation or tests.
