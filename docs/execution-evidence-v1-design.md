# execution-evidence-v1 design

Date: 2026-08-27
Status: diagnostic compatibility projection
Tracks: #148, #149, #150, #151, #152, #153, #154

## Compact-state amendment (2026-09-01)

`execution-evidence-v1` is a diagnostic historical projection, not an execution-correctness substrate. Recovery, resumption, mutation certainty, and authorization depend on compact current state (`orchestration_runs`, `execution_state`, unresolved `operation_state`, exact `proof_state`) plus fresh authoritative reads. Historical journals, horizons, heartbeats, checkpoints, and superseded receipts may be retention-bounded or absent without changing a correctness decision.

Where retained, v1 remains useful for answering historical operator questions. A future current-facts evidence schema should project compact execution facts, terminal effect tombstones, exact-revision proofs, and fresh authority observations rather than reconstructing chronology.

## 1. Outcome

Overcenter will expose one canonical consumer-facing representation of what it can truthfully say happened during a bounded execution run.

The data product is **Overcenter Execution Evidence**. Its native semantic representation is `execution-evidence-v1`.

`execution-evidence-v1` is a deterministic diagnostic read projection over retained Overcenter execution telemetry and explicitly bounded observations of external authorities. It does not create a second execution ledger, a second project authority, a provider mirror, or an agent-authored historical narrative, and its source rows are not required to remain durable for execution correctness.

The organizing invariant is:

> Every fact in `execution-evidence-v1` is either an Overcenter-owned execution fact or a bounded observation of an explicitly named external authority.

The first consumer is the Overcenter operator. A single exact-run read should answer “what actually happened?” without requiring the operator to reconstruct the story from raw run rows, leases, journal entries, command receipts, recovery records, and verification surfaces.

ODCS is a downstream external representation of this established data product. It does not define Overcenter runtime architecture.

## 2. Authority model

### 2.1 Overcenter-owned facts

Overcenter is authoritative for the execution facts it creates and durably records, including:

- orchestration run identity, bounds, status, and disposition;
- execution authority granted through work or transition leases;
- checkpoints and bounded liveness evidence;
- semantic command invocation identity and outcome classification;
- durable mutation receipts and invocation-resolution evidence;
- settlement state and settlement receipts;
- deterministic recovery decisions and recorded recovery resolutions;
- Overcenter verification receipts.

Overcenter also owns the semantics of deterministic evidence-integrity classification. Integrity results are derived from durable evidence and are not a second durable authority unless a future design explicitly requires a receipt for a particular verification boundary.

### 2.2 Externally observed facts

GitHub, Linear, and other providers remain authoritative for their own state. Overcenter may project only the bounded provider observation required to support an execution claim.

A provider observation in `execution-evidence-v1` must identify, where available:

- `authority`: canonical provider or authority kind;
- `subject`: stable provider coordinate or Overcenter canonical reference;
- `revision`: exact observed revision, commit SHA, head SHA, or equivalent authority coordinate;
- `observed_at`: durable observation time when the source record provides one;
- `projection`: only the execution-relevant fields needed to support the claim.

The data product must not copy complete GitHub or Linear objects merely because they are available.

### 2.3 No authority promotion by projection

Reading `execution-evidence-v1` does not make a projection authoritative for provider state. A later provider change does not rewrite historical execution evidence. Current provider truth is obtained through the appropriate authoritative observation operation.

## 3. Diagnostic compatibility source map

The original v1 projector reads the following records when they are retained. This table describes diagnostic inputs, not required durable state. Compact-state correctness must continue to work when these historical sources are empty or physically absent:

| Semantic entity | Primary durable source | Notes |
| --- | --- | --- |
| Run | `orchestration_runs` | Run identity, bounds, scope, status, disposition, terminal reason, timestamps |
| Run target | `orchestration_runs.target`, `target_sha256`, `base_start_request_sha256` | Immutable targeted-run identity where present |
| WorkObservation | lease claim/settlement projections, run target/horizon evidence, bounded journal projections | Never a shadow Linear issue |
| Lease | `work_leases` | Project only non-secret authority evidence; never expose `lease_token` or token hash |
| Checkpoint | `work_lease_checkpoints` | Durable resumable progress, ordered deterministically |
| Liveness | `work_lease_heartbeats` | Include only when needed to explain lease chronology or integrity |
| CommandInvocation | `orchestration_command_invocations` | Canonical command, safe target, request/result digests/projections, outcome, mutation uncertainty |
| EffectReceipt | command-specific durable receipt plus journal projection | Keep command-specific receipt authority; do not duplicate it into a new ledger |
| InvocationResolution | `orchestration_invocation_resolutions` | Append-only resolution of indeterminate or interrupted invocation state |
| Settlement | `work_leases.settle_plan`, `settle_receipt`, `settled_at` | Preserve authority-before/after and execution precondition evidence where durably present |
| Verification | `portfolio_verification_receipts` and command-specific exact verification evidence | Only explicit verification records count as verification |
| RecoveryEvent | invocation resolutions and deterministic recovery evidence | Do not invent a generic recovery event when no durable recovery fact exists |

If implementation discovers that a desired v1 field cannot be derived truthfully from these sources, v1 omits the field or returns explicit unknown state. A new durable fact requires a separate narrow justification. The projector must not solve missing evidence by asking an agent to summarize history.

## 4. Canonical top-level shape

The run is the v1 query and aggregation boundary.

```json
{
  "schema": "execution-evidence-v1",
  "run": {},
  "target": null,
  "work_observations": [],
  "leases": [],
  "checkpoints": [],
  "commands": [],
  "settlements": [],
  "verifications": [],
  "recoveries": [],
  "integrity": {
    "status": "not_evaluated",
    "violations": []
  }
}
```

The native projection itself should not contain a wall-clock `generated_at` field because that would make identical durable evidence produce different semantic values on each read. The enclosing `command-response-v1` read response may continue to expose its normal `observed_at` timestamp.

Arrays use deterministic ordering:

- commands by durable invocation sequence, then invocation ID as tie-breaker;
- leases by creation time, then lease ID;
- checkpoints by creation time, then checkpoint ID;
- settlements by settled time, then lease ID;
- verifications and recoveries by durable event time, then stable ID.

## 5. Entity semantics

### 5.1 Run

The run projection identifies the bounded execution session and its terminal condition without claiming project success.

Minimum shape:

```json
{
  "run_id": "...",
  "worker": "...",
  "mode": "interactive|scheduled",
  "continuation_key": "...",
  "scope": {},
  "status": "...",
  "disposition": null,
  "started_at": "...",
  "deadline_at": "...",
  "finished_at": null,
  "stop_reason": null,
  "predecessor_run_id": null
}
```

A terminal run disposition is not equivalent to verified work completion. For example, `blocked` may be a completely truthful and evidence-complete run result.

### 5.2 WorkObservation

`WorkObservation` is a bounded statement about work authority as observed during execution. It is not a replicated Linear issue.

Minimum useful fields are:

```json
{
  "work_ref": "LJH-466",
  "authority": "linear",
  "revision": "...",
  "execution_fingerprint": "...",
  "state": "...",
  "lane": "...",
  "repository": "...",
  "observation_role": "claim|settlement|horizon|verification",
  "source_ref": "..."
}
```

Fields are included only when already present in a safe durable execution projection. Unrelated comments, labels, broad provider prose, generic revision counters, and complete provider objects remain outside the data product.

### 5.3 Lease

A lease record represents temporary Overcenter execution authority.

The projection may include:

- `lease_id`;
- `run_id`;
- `work_ref`;
- `gate`;
- `status`;
- claim/activation/expiry/settlement timestamps;
- claim authoritative revision;
- active revision when present;
- non-secret execution fingerprint or authority coordinates;
- receipt references.

The projection must never include:

- `lease_token`;
- token hashes as consumer data;
- secret-bearing request material.

Historical lease rows do not imply current authority. Current authority must be represented separately from historical lease existence and must follow existing lease/slot semantics.

### 5.4 Checkpoint

A checkpoint represents durable resumable semantic progress under an exact lease. It should expose a bounded safe projection of the stored checkpoint and its digest, not arbitrary agent context.

The checkpoint projection includes stable checkpoint identity, lease identity, digest, durable timestamp, and safe semantic progress fields already admitted by the checkpoint contract.

### 5.5 CommandInvocation

A command record preserves the original durable invocation outcome exactly. Later recovery never rewrites this outcome.

Minimum shape:

```json
{
  "invocation_id": "...",
  "sequence": 12,
  "command": "github.apply_changeset",
  "target": {"kind": "repository", "ref": "owner/repo"},
  "started_at": "...",
  "completed_at": "...",
  "outcome": "running|succeeded|rejected|failed|indeterminate",
  "error": {
    "code": null,
    "class": null,
    "retryable": null,
    "rejection": null
  },
  "may_have_mutated": null,
  "request_sha256": "...",
  "result_sha256": "...",
  "request": {},
  "result": {},
  "effect": {},
  "resolution_refs": []
}
```

`request` and `result` use the existing bounded safe journal projection policy. The implementation should centralize or reuse the existing redaction logic rather than maintain a competing list of sensitive keys.

### 5.6 EffectReceipt and mutation certainty

Mutation certainty is a derived semantic view over the original invocation plus durable resolution evidence. It does not erase or replace the invocation outcome.

The stable v1 certainty vocabulary is:

- `not_applicable`: command is observational or no external mutation is in scope;
- `definitively_absent`: durable evidence proves no external effect occurred;
- `confirmed_present`: durable evidence confirms the external effect occurred;
- `unknown`: an external effect may have occurred and has not been conclusively resolved.

Initial deterministic derivation rules:

| Durable evidence | v1 mutation certainty |
| --- | --- |
| command is read-only | `not_applicable` |
| `rejected` or failed validation with `may_have_mutated = false` | `definitively_absent` |
| durable resolution `definitively_not_applied` | `definitively_absent` |
| durable resolution `externally_confirmed` | `confirmed_present` |
| unresolved `indeterminate` | `unknown` |
| `may_have_mutated = true` with no conclusive resolution | `unknown` |
| `superseded` or `abandoned` without separate conclusive effect evidence | `unknown` |

A command outcome of `succeeded` does not by itself mean the intended resulting state is verified. For mutation commands, whether success is enough to classify the immediate external effect as `confirmed_present` is command-specific and must follow the command’s durable receipt contract. The projector must not infer this generically.

### 5.7 Settlement

Settlement represents the terminal disposition of claimed work authority, not merely run termination.

Project:

- lease/work/gate identity;
- settlement disposition;
- settled timestamp;
- bounded evidence references;
- authority-after observation when durably present;
- execution-precondition verification flag;
- relevant claim and pre-settlement authority revisions where existing receipt semantics expose them.

Settlement that remained indeterminate or unresolved must never be projected as cleanly settled.

### 5.8 Verification

Verification is first-class because “command succeeded” and “intended resulting state is verified” are different claims.

A verification record must point to explicit durable verification evidence. Absence of a verification receipt is `unknown` or `not_applicable` according to command/work semantics, never implicit success.

The projection should distinguish:

- `verified`;
- `failed`;
- `not_applicable`;
- `unknown`.

The initial implementation must not fabricate a universal verification requirement. Required verification is command-aware and work-semantics-aware.

### 5.9 RecoveryEvent

Recovery evidence is append-oriented. A recovery event may represent deterministic reconciliation, invocation resolution, abandoned-run maintenance, or another durable recovery fact already owned by Overcenter.

The projection must preserve:

- what prior evidence required recovery;
- recovery kind;
- recovery result/resolution;
- durable evidence reference;
- whether the original outcome remains historically indeterminate even though its effect certainty was later resolved.

### 5.10 Example projection excerpts

The examples are intentionally partial. They show semantic distinctions, not every optional field.

#### Clean verified success

```json
{
  "schema": "execution-evidence-v1",
  "run": {"run_id": "run-success", "status": "finished", "disposition": "completed"},
  "leases": [{"lease_id": "lease-1", "work_ref": "WORK-1", "status": "settled"}],
  "commands": [{
    "invocation_id": "inv-1",
    "command": "github.apply_changeset",
    "outcome": "succeeded",
    "may_have_mutated": true,
    "effect": {"mutation_certainty": "confirmed_present"},
    "resolution_refs": []
  }],
  "settlements": [{"lease_id": "lease-1", "settlement_disposition": "completed"}],
  "verifications": [{"status": "verified", "source_ref": "verification:work:WORK-1"}],
  "integrity": {"status": "complete", "violations": []}
}
```

The command effect and the resulting-state verification are separate facts even though both are resolved positively.

#### Pre-mutation rejection

```json
{
  "schema": "execution-evidence-v1",
  "run": {"run_id": "run-blocked", "status": "finished", "disposition": "blocked"},
  "leases": [],
  "commands": [{
    "invocation_id": "inv-2",
    "command": "work.claim",
    "outcome": "failed",
    "error": {"code": "REQUEST_INVALID", "class": "validation", "retryable": false, "rejection": false},
    "may_have_mutated": false,
    "effect": {"mutation_certainty": "definitively_absent"},
    "resolution_refs": []
  }],
  "settlements": [],
  "verifications": [],
  "integrity": {"status": "complete", "violations": []}
}
```

A blocked run can have a complete evidence story. No lease, external effect, or settlement is fabricated.

#### Indeterminate effect later resolved by authority

```json
{
  "schema": "execution-evidence-v1",
  "run": {"run_id": "run-recovered", "status": "active", "disposition": null},
  "commands": [{
    "invocation_id": "inv-3",
    "command": "github.apply_changeset",
    "outcome": "indeterminate",
    "may_have_mutated": true,
    "effect": {"mutation_certainty": "confirmed_present"},
    "resolution_refs": ["resolution:inv-3:1"]
  }],
  "recoveries": [{
    "recovery_ref": "resolution:inv-3:1",
    "invocation_id": "inv-3",
    "resolution_kind": "externally_confirmed"
  }],
  "verifications": [{"status": "unknown"}],
  "integrity": {"status": "not_evaluated", "violations": []}
}
```

The original command remains historically `indeterminate`; later authoritative evidence resolves mutation certainty without rewriting the original invocation outcome. Resulting-state verification remains independent.

## 6. Evidence completeness and integrity

`execution-evidence-v1` separates **execution outcome** from **evidence integrity**.

A blocked or failed run can be evidence-complete. A run that appears successful while an external mutation remains unresolved is not evidence-complete.

The integrity verifier introduced by #152 operates deterministically over the canonical projection plus command-specific evidence requirements.

Initial stable violation classes should cover:

- `TERMINAL_RUN_WITH_UNRESOLVED_MUTATION`;
- `REQUIRED_VERIFICATION_MISSING`;
- `SETTLEMENT_EVIDENCE_INCOMPLETE`;
- `VERIFICATION_EVIDENCE_UNRESOLVED`;
- `RECOVERY_CONTRADICTS_MUTATION_CERTAINTY`;
- `LEASE_SETTLEMENT_STATE_INCONSISTENT`;
- `CONFIRMED_SUCCESS_WITH_UNKNOWN_EFFECT`;
- `EVIDENCE_REFERENCE_UNRESOLVED`.

Each violation includes a stable code, severity/class, affected evidence reference, and bounded machine-readable details.

`integrity.status` is one of:

- `not_evaluated` before the verifier is applied;
- `complete` when no integrity violations remain;
- `incomplete` when one or more integrity violations remain.

Evidence completeness does not mean project correctness. It means the execution story is internally truthful and sufficiently resolved under the declared command/work semantics.

## 7. `execution.get_evidence`

The first semantic read operation is run-centric:

```json
{
  "run_id": "exact-run-id"
}
```

V1 intentionally does not accept arbitrary query predicates, caller-authored provider snapshots, graph state, or reconstruction hints.

The operation is:

- read-only;
- privileged/admin-scoped;
- non-journaled into the run being observed, following the same anti-shadowing principle as `orchestration.resume_packet` and `orchestration.diagnose`;
- incapable of granting execution authority;
- incapable of mutating provider or runtime state.

The response uses normal `command-response-v1` envelope semantics and includes the canonical `execution-evidence-v1` projection as its domain payload.

Missing runs return a stable `not_found` class. Malformed input returns stable validation failure. A read failure never invents partial success.

## 8. Operator checkpoint projection

#153 derives a smaller operator checkpoint from canonical evidence plus integrity results.

The checkpoint is disposable and re-derivable. It is not stored as a second authority.

It should answer, when evidence permits:

- current run condition;
- work identity relevant to the stop boundary;
- whether execution authority is currently active;
- whether claim/lease acquisition occurred;
- command/effect certainty at the boundary;
- verification state;
- settlement state;
- whether deterministic recovery is required or available;
- whether operator judgment is required;
- the exact deeper evidence references needed for drill-down.

Representative blocked-before-lease checkpoint:

```json
{
  "run_status": "terminal",
  "run_disposition": "blocked",
  "work_ref": "LJH-466",
  "claim": "rejected",
  "active_authority": false,
  "external_effects": "definitively_absent",
  "verification": "not_applicable",
  "settlement": "not_applicable",
  "recovery_required": false,
  "integrity": "complete",
  "blocking_error": "REQUEST_INVALID"
}
```

The checkpoint must never turn an unresolved effect into a generic “retry” instruction. If an effect is `unknown`, the checkpoint exposes that condition and the existing command-specific recovery boundary.

## 9. Privacy and redaction

The execution-evidence surface is privileged because run/work/repository details may themselves be private even when the Overcenter source repository is public.

The projector must exclude:

- prompts and chain of thought;
- arbitrary conversation content;
- passwords, credentials, API tokens, lease tokens, secret material;
- full patches, complete source files, retained binaries;
- arbitrary request or response bodies;
- complete Linear/GitHub/provider objects;
- unrelated provider prose/content.

Reuse the existing bounded journal projection/redaction rules where possible. If the projection needs a shared helper, extract one canonical safe-projection utility rather than copying regexes and limits into another subsystem.

No public preview field is added by this work. A future public-safe execution summary would require a separate explicit privacy design.

## 10. Determinism

The projector is a pure semantic read over supplied durable rows after normalization. For unchanged source evidence it must return semantically identical output.

Determinism requirements:

- stable array ordering;
- no random IDs;
- no read-time wall-clock fields inside the native projection;
- no LLM synthesis;
- no provider reread unless the operation explicitly declares and records a bounded authoritative observation outside the historical projection;
- no silent repair during read;
- unknown remains unknown until durable evidence resolves it.

The first implementation should prefer repository-owned pure projection functions that can be tested with synthetic records independently of Postgres/Hatchable adapters.

## 11. Implementation shape

Recommended code boundaries:

```text
lib/execution-evidence.js
    pure normalization, linking, certainty derivation, stable projection

lib/execution-evidence-store.js
    read adapters for run, lease, checkpoint, journal, resolution,
    verification, and target records

lib/execution-evidence-integrity.js
    deterministic command-aware completeness checks

api/execution/get-evidence.js
    privileged HTTP adapter

mcp/execution.get_evidence.js
    semantic MCP contract

public/docs/execution-evidence-v1.md
    normative consumer documentation
```

Exact filenames may follow existing repository conventions during implementation. The architectural rule is more important than the names: pure projector, source adapters, integrity verifier, and semantic transport remain separate concerns.

No schema migration is planned for #150 or #151.

## 12. Testing strategy

The first slice must be test-driven with synthetic fixtures representing at least:

### 12.1 Clean verified success

- run exists;
- lease acquired;
- semantic mutation command succeeds with durable receipt;
- resulting state has explicit verification evidence;
- work settles;
- run terminalizes;
- integrity is complete.

### 12.2 Pre-mutation rejection

- authoritative work selected/observed;
- claim or command is rejected before mutation;
- `may_have_mutated = false`;
- no lease/effect/settlement is fabricated;
- mutation certainty is `definitively_absent`;
- blocked run may still have `integrity = complete`.

### 12.3 Indeterminate effect later resolved present

- original command remains `indeterminate`;
- initial mutation certainty is `unknown`;
- durable invocation resolution later records `externally_confirmed`;
- next projection reports `confirmed_present` while retaining original outcome history;
- verification remains independent.

### 12.4 Indeterminate effect later resolved absent

- durable resolution `definitively_not_applied`;
- mutation certainty becomes `definitively_absent`;
- original invocation remains historically `indeterminate`.

### 12.5 Incomplete evidence

- terminal run or apparent success with unresolved potentially-mutating invocation;
- integrity verifier emits stable violation;
- no false verified/complete claim.

### 12.6 Redaction

- synthetic journal projections contain token/secret/password/credential/content/body-shaped fields;
- forbidden material does not appear in `execution-evidence-v1`.

Canonical regression registration follows existing Overcenter verification conventions once the focused tests are green.

## 13. Rollout and sequencing

1. **#149** lands the normative semantic contract and examples.
2. **#150** lands the pure deterministic projector and source adapters without a new evidence table.
3. **#151** exposes the privileged `execution.get_evidence` read operation.
4. **#152** adds deterministic evidence-integrity checks and canonical regression coverage.
5. **#153** replaces transcript-heavy operator resume context with a compact derived checkpoint where appropriate.
6. **#154** publishes and validates ODCS v3.1 for the established data product.

The execution-loop work in #136 through #139 may consume the operator checkpoint once available. #141 may derive execution-leverage metrics from the same canonical evidence rather than creating another analytics ledger.

## 14. ODCS boundary

The native model is authoritative for Overcenter execution semantics. ODCS describes that model for consumers.

The eventual ODCS v3.1 artifact should map:

- fundamentals to stable contract identity/version/status/purpose/limitations;
- schema to the consumer-facing `execution-evidence-v1` objects, not SQL tables;
- references to stable run/work/lease/invocation/verification identities;
- data quality to real deterministic invariants from #152;
- authoritative definitions to normative Overcenter contracts and named provider authorities;
- support/team/roles only where they communicate real consumer obligations;
- infrastructure/server fields only for actual supported delivery surfaces;
- SLA/freshness/retention fields only when Overcenter genuinely makes those promises.

Do not create an ODCS contract for every internal table. Do not use ODCS as an OpenAPI replacement. Do not fabricate SLA values to populate optional sections.

## 15. Non-goals

This work does not:

- replace `command-response-v1`;
- replace work/transition lease authority;
- replace command-specific durable receipts;
- replace GitHub or Linear authority;
- create a second execution ledger;
- introduce generic event sourcing;
- persist agent summaries;
- persist chain of thought;
- expose private run evidence publicly;
- create a generic query language over Overcenter internals;
- make a terminal run synonymous with verified project completion;
- make ODCS the internal runtime schema.

## 16. Decision summary

The implementation should optimize for one property above all others: **truthful compression**.

Overcenter already records the machinery required to execute safely. `execution-evidence-v1` turns that machinery into a stable semantic read model so operators and software can consume the verified story without re-performing the bookkeeping. The raw evidence stays authoritative where it already lives; the projection makes its meaning composable.
