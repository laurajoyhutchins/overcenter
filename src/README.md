# Source layout

The source tree is organized by architectural authority, not by implementation accident.

```text
src/
├── analysis/       deterministic static and runtime-reachability analysis
├── architecture/   relational architecture queries, reconciliation, and change planning
├── authority/      project truth, admission, replay, recovery, and realization reuse
├── cli/            product and operator command entrypoints
├── evidence/       system evidence, hostile-evidence obligations, and evidence storage
├── graph/          dependency topology and semantic identity
├── observation/    external-state observation and evidence interpretation
├── execution/      authorized computation, confinement, and executor transport
│   ├── executor/      Go physical computation executor
│   ├── confinement/   Rust native worker-confinement substrate
│   └── worker-client/ portable untrusted assignment client
├── providers/      provider-specific API and resource semantics
├── source/         bounded source proposal, verification, and integration protocol
├── storage/        durable fact-store implementations
├── generated/      checked generated runtime artifacts
├── model.ts        shared public data model
├── semantics.ts    cross-provider settlement and effect semantics
├── digest.ts       canonical hashing
├── structural-schema.ts
└── validation.ts   cross-cutting deterministic validation primitives
```

## Boundary rule

Paths should answer what the code is allowed to decide.

- `analysis/` observes mechanically recoverable code and effect relationships. Analysis results do not become authority merely because they were derived.
- `architecture/` queries and reconciles the declarative SQL architecture model. See [the relational architecture model](../architecture/README.md).
- `authority/` may determine Overcenter project truth from admitted definitions and durable evidence.
- `cli/` exposes only the `project.advance` and `project.submit` command entrypoints while delegating semantics to the owning architectural modules.
- `evidence/` materializes and stores bounded evidence inputs. Evidence still requires the owning verifier and authority transition.
- `graph/` describes topology and semantic identity. It does not settle work.
- `observation/` reports and interprets external state. It does not mutate project truth directly.
- `execution/` performs already-authorized work and returns attempt evidence. It does not decide eligibility or settlement.
- `providers/` contains provider-specific API and resource semantics that stay outside the provider-general authority core.
- `source/` owns the bounded source-change proposal, broker, verification, and exact-base integration protocol. See [the source-change protocol](../docs/source-change-protocol.md).
- `storage/` persists durable facts. Storage backends do not define authority policy.
- Root source files are reserved for genuinely cross-cutting primitives.

Provider credentials are capabilities, not project authority. A provider credential may create or observe provider state, but Overcenter must independently establish admitted identity, authorization, observation, and postcondition before that state can affect project truth. See [provider capability boundaries](../docs/provider-capabilities.md).

There are no compatibility barrels for the former flat `src/` layout. Callers import canonical paths directly, so stale paths fail during compilation or tests rather than being silently adapted.
