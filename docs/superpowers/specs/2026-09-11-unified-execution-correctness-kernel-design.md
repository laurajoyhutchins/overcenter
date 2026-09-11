# Unified execution correctness kernel

- Date: 2026-09-11
- Repository: laurajoyhutchins/overcenter
- Design source revision: ddc844dedab005ef54ac4e9892e7d84e44054b5b
- Status: approved direction, implementation gated on this written-spec review
- Semantic source of truth: TypeScript under src/semantic; runtime JavaScript under lib is generated output only

## Decision

Promote Overcenter's existing compact execution substrate into one ordinary-function execution transaction kernel. Do not add a second kernel, a compatibility facade, or a new v2 protocol.

The kernel is the only generic boundary that turns an uncertain external effect into verified Overcenter state. It owns the execution identity, authority fence, lease claim, effect attempt, mutation certainty, evidence binding, deterministic recovery classification, and durable settlement. Providers expose only exact effect and readback capabilities.

The current compact records are the migration substrate:

- execution_state is the canonical active execution, lease, authority, and lifecycle record.
- operation_state is the idempotent external-effect attempt ledger. It is not a second workflow state machine.
- proof_state is the durable exact-identity proof ledger.
- orchestration_runs is correlation and continuation state only. It is not an authority, lease, evidence, or settlement source.

The existing TypeScript semantic modules are promoted and consolidated. The JavaScript under lib is regenerated from TypeScript by the repository build; no hand-maintained JS/TS semantic pair survives.

## Why this change

The current repository answers the same correctness questions in several places:

| Responsibility | Current implementations | Authoritative implementation today | Duplication | Planned survivor | Planned deletion |
|---|---|---|---|---|---|
| Work ownership | lib/work-leases.js, lib/work-lifecycle.js, work_lease tables | Neither; compact project-transition path is newer | Legacy work leases and project-transition leases both claim work | Kernel claim against execution_state | Work lease runtime and callers |
| Project-transition ownership | lib/project-transition-leases.js, lib/project-transition-lease-store.js, project-transition tables | Compact execution_state on the atomic path | Atomic and insert/slot compatibility acquire paths | Kernel lease claim | Legacy insertLease/insertSlot path and lease ceremony |
| Run identity | lib/orchestration-runs.js, lib/orchestration-journal.js, command invocations | orchestration_runs for correlation | Journals and run records both describe execution | Kernel execution_id plus run correlation pointer | Correctness decisions in journal modules |
| Authority fencing | lib/execution-authority-core.js, lib/execution-authority.js, project-transition workspace helpers, provider preflight | Compact authority fields plus project-transition checks | Legacy-work and project-transition branches answer the same stale-authority question | Kernel fence using exact revision and epoch | Separate authority contracts and duplicate branches |
| Mutation certainty | lib/mutation-certainty.js, provider error helpers, execution-evidence-contracts.js | No single source | Three-level and four-level vocabularies, plus booleans | One TypeScript certainty lattice | Provider-local certainty/recovery decisions |
| Effect idempotency | compact-provider-operation-store.js and each compact provider receipt store | operation_state | One generic store wrapped by changeset, release, promotion, and reconcile stores | Kernel operation ledger | Provider-specific receipt stores |
| Evidence | lib/execution-evidence.js, execution-evidence-store.js, bounded-evidence.js, verification receipt stores | No single source | Narrative, legacy journal, provider receipt, and compact proof forms | proof_state with typed exact-identity evidence | Legacy evidence stores and evidence reconstruction |
| Settlement | deterministic-work-settlement.js, project-transition settlement, provider receipt stores, orchestration finish paths | No single source | Linear/project, provider, and orchestration settlement each close work differently | One kernel settle transaction and SettlementReceipt | Per-subsystem settlement implementations |
| Recovery | orchestration-recovery.js, project-transition-github-recovery.js, provider receipt recovery, production runtime recovery | No single source | Same uncertain-effect cases classified by caller | Kernel recovery classifier and confirm-only path | Provider and agent recovery policy |
| GitHub changesets | github-apply-changeset.js, github-lease-scoped-changeset.js, branch-role runtime, worker mutations | GitHub adapter plus project-transition lease checks | Provider path owns generic leases, retry, and confirmation ceremony | Thin GitHub effect/readback capability | Generic protocol in GitHub modules |
| Release/promotion | github-release.js, compact-github-release-receipt-store.js, github-production-promotion*.js | Separate provider receipts | Release and promotion each reimplement operation state | Kernel with GitHub capability | Pseudo-leases and receipt stores |
| Project authoring | project-authoring-runtime.js and GitHub mutation orchestration | Separate authoring runtime | Authoring has its own fence, mutation certainty, and readback | Project-definition intent through kernel | Separate authoring execution protocol |
| Command ingress | Hatchable dispatch wrapper, GCP workflow, Cloud Run worker | GCP worker | Transport records and semantic records are mixed at the edges | Hatchable/GitHub Actions remain transport only | Any Hatchable semantic bookkeeping |

This is a deletion plan, not a plan to retain every row behind a new interface.

## Canonical TypeScript kernel

The final semantic source of truth is a small set of ordinary functions and typed values:

- src/semantic/execution-transaction.ts
  - ExecutionIntent
  - ExecutionIdentity
  - ExecutionLifecycle
  - MutationCertainty
  - ExecutionEvidence
  - SettlementReceipt
  - executeExecutionTransaction
  - confirmExecutionTransaction
  - settleExecutionTransaction
  - classifyExecutionRecovery
- src/ports/execution-transaction-store.ts
  - one persistence port for claim, fence, attempt, proof, settle, and inspection
- src/adapters/postgres/execution-transaction-store.ts
  - one PostgreSQL implementation using compare-and-set updates and transaction boundaries
- src/semantic/provider-effect.ts, or an equivalent type section in execution-transaction.ts
  - the smallest provider capability shape: preflight, invoke, readback

The current compact TypeScript files are not a parallel implementation. Their validated values and PostgreSQL behavior are moved into these canonical modules, then the old names are removed. In particular, execution-authority-core.ts, execution-evidence.ts, mutation-certainty.ts, and compact-execution-state.ts either become internal sections of the transaction module or are deleted after their behavior is covered by the kernel tests.

The generated lib files remain necessary at the Cloud Run runtime boundary. They are produced by scripts/build.mjs and checked for source/runtime drift. A semantic change is authored in TypeScript first and never hand-patched independently in lib.

## Execution identity

One semantic intent creates one stable execution_id. The kernel derives and persists the complete identity before an external effect is permitted:

- execution_id: stable transaction identity for the semantic intent.
- project_ref and subject_key: project and semantic subject.
- operation_id: stable identity for the particular provider effect.
- idempotency_key and idempotency_scope: stable replay identity.
- run_id: correlation to the orchestration invocation, never the authority by itself.
- attempt_epoch: monotonically increasing attempt number for this operation.
- lease_ref and lease_epoch: current exclusive owner and fencing generation.
- authority_epoch: exact Overcenter authorization epoch.
- authority_repository and authority_revision: exact Git authority, normally a full Git commit SHA.
- graph_fingerprint and transition_fingerprint: semantic meaning that was approved.
- intent_sha256: canonical hash of the complete intent.

A duplicate delivery with the same intent and idempotency identity returns the existing transaction outcome. A replacement worker may receive a new lease_epoch and attempt_epoch, but it continues the same execution_id and operation_id. It must confirm an uncertain effect before any new effect attempt.

The kernel, not a caller, creates these values. A provider request cannot supply its own repository, branch, base SHA, retry key, lease token, or run identity.

## Lifecycle and facts

There is one externally meaningful lifecycle:

    prepared -> executing
              -> effect_uncertain
              -> effect_confirmed
              -> settled

    executing -> effect_absent -> settled
    prepared  -> rejected
    effect_uncertain -> escalated

The names describe durable facts, not workflow intentions.

- prepared: identity, intent, authority, and idempotency row exist; no effect has been attempted.
- executing: one fenced worker owns the current attempt.
- effect_uncertain: transport or storage outcome leaves open whether the provider mutated.
- effect_confirmed: exact provider readback or idempotent provider response proves the intended effect.
- effect_absent: evidence proves the effect definitely did not occur.
- settled: durable project-facing outcome and receipt exist for this exact execution.
- rejected: a pre-effect fence, input, or authority check failed.
- escalated: deterministic confirmation/recovery cannot safely continue.

Mutation certainty is a monotonic fact lattice, represented in TypeScript with explicit names:

- definitely_not_mutated
- may_have_mutated
- confirmed_mutated

The order is monotonic. A provider response or database error can move certainty upward, never downward. A readback can prove confirmed_mutated; it cannot turn an already possible mutation into a blind retry permission. The kernel chooses the lifecycle transition from the fact and evidence.

operation_state remains the idempotent attempt ledger, but callers no longer branch on a separate provider workflow state. It records operation_id, attempt_epoch, request hash, transport facts, certainty, provider reference, response hash, and confirmation evidence. execution_state owns the one lifecycle above. proof_state records immutable proof facts, not a second lifecycle.

## Kernel protocol

Every execution follows the same deterministic sequence:

1. Prepare the intent. Canonicalize it and persist execution identity, exact authority, and idempotency identity.
2. Claim the execution. A PostgreSQL compare-and-set claim creates or advances one lease epoch. A unique constraint prevents two current owners.
3. Fence immediately before effect. Re-read the exact authority and provider workspace. A revision, graph fingerprint, authority epoch, or lease mismatch rejects before mutation.
4. Prepare the operation row. The operation request hash and attempt epoch are durable before the provider call.
5. Invoke the provider capability once. The provider knows how to perform its exact effect, but does not claim, retry, settle, or recover.
6. Normalize the result. The adapter returns provider facts and readback handles. The kernel assigns the common certainty value.
7. Confirm when uncertain. The kernel calls provider readback with the same exact identity. It never blindly repeats a possibly-mutating effect.
8. Capture structured proof. Proof includes execution_id, operation_id, attempt_epoch, authority_epoch, authority_revision, provider reference, predicate, observation timestamp, and evidence hash.
9. Settle in one database transaction. The transaction rechecks the current lease fence, exact identity, certainty, and proof; writes the settlement receipt and closes the execution. A stale worker affects zero rows.
10. Derive authoritative project truth. project.inspect reads fresh GitHub authority and the durable kernel result. It does not infer completion from an agent response, provider HTTP success, or a narrative receipt.

The settlement boundary is the only place allowed to produce a project-facing completed transition. Generated output, a branch update, a provider response, or an agent claim is not settlement by itself.

## Database design

Use the existing compact tables as the migration substrate instead of introducing an unrelated v2 schema.

execution_state is extended and simplified to contain:

- execution_id, subject_key, project_ref, operation_id
- lifecycle
- lease_ref, lease_epoch, lease_expires_at
- authority_epoch, authority_repository, authority_revision
- graph_fingerprint, transition_fingerprint, intent_sha256
- current_attempt_epoch
- current operation/proof pointers
- settled_at and settlement receipt hash

operation_state contains one durable idempotent effect ledger:

- operation_id, execution_id, idempotency_scope, idempotency_key
- attempt_epoch and request_sha256
- effect kind and provider reference
- mutation certainty and result/response hashes
- confirmation predicate and confirmation timestamp
- recovery resolution, only when the kernel determines it

proof_state contains append-only exact proof:

- proof_id and execution_id
- operation_id and attempt_epoch
- predicate kind
- authority repository, authority revision, and authority epoch
- evidence SHA-256 and structured evidence references
- observed_at

orchestration_runs keeps run correlation, continuation, and a pointer to unresolved kernel work. It cannot independently settle, change authority, acquire a second lease, or certify evidence.

Database invariants:

- unique active execution for a subject and unique idempotency identity for an operation;
- foreign keys from operation and proof rows to the execution;
- immutable identity columns after preparation;
- monotonic certainty check; no transition from possible to definitely_not_mutated;
- compare-and-set writes require execution_id, lease_ref, lease_epoch, and authority_epoch;
- settlement requires a confirmed or definitely-absent operation plus exact proof;
- evidence revision and authority epoch must equal the execution identity;
- one settlement receipt per execution;
- stale lease updates affect zero rows;
- no operation can be compacted or treated as settled while certainty is may_have_mutated.

Legacy tables and migrations remain as historical database history where deleting migration files would make the schema history unverifiable. After cutover, live code has no correctness read/write path to work_leases, work_lease_slots, provider receipt tables, command invocation journals, or legacy verification ledgers. Freeze triggers remain as a guard until the final cleanup wave.

## Provider boundary

The provider capability is intentionally small:

- preflight: read the exact provider object/workspace and return its observed identity;
- invoke: perform one exact effect using kernel-supplied identity and idempotency data;
- readback: determine whether this exact operation occurred and return structured provider evidence.

The capability may contain GitHub-specific safety such as full SHA comparison, conditional updates, branch-role rules, or GitHub App permission checks. It may not own generic lease semantics, retry policy, settlement, recovery, or authority identity.

Examples after migration:

- GitHub changeset capability creates, updates, or deletes exact text at the kernel-derived workspace.
- GitHub pull-request capability marks the exact PR head ready.
- GitHub release and production capabilities verify exact commits and read back tags/releases/materialization.
- Cloud Run capability invokes and confirms the exact operation.
- Portfolio reconciliation capability reads and writes its provider effect through the same transaction boundary.

The current provider receipt stores become unnecessary. A provider result is an operation ledger entry and proof row, not a provider-owned settlement record. GitHub-specific modules lose their orchestration wrappers and retain only provider API translation and provider-specific preconditions.

Hatchable remains a stateless transport wrapper. GitHub Actions may relay a command to the authoritative GCP worker and post bounded diagnostics, but neither transport layer owns semantic state, leases, evidence, or recovery.

## Semantic operation integration

project.advance remains the primary semantic entry point. It selects or resumes an intent and calls the kernel. A reasoning agent may supply a bounded judgment, a desired change, or a candidate operation payload. It never supplies lease identity, authority epoch, mutation certainty, proof, recovery permission, or settlement.

project.amend and project.define become ordinary semantic intents executed through the same kernel. Their exact GitHub mutation and authoritative readback are provider capabilities. The authoring runtime no longer maintains a parallel authority/mutation-certainty/readback protocol.

production.promote, production.reconcile, release.publish, GitHub integration commands, and future provider effects call the same kernel function. Internal command endpoints may remain temporarily as thin adapters during migration, but their callers are migrated in the same work and the old endpoint protocol is deleted rather than exposed as a permanent v2 surface.

## Deterministic recovery

Recovery classification is a pure function of durable execution facts:

| Durable fact | Kernel permission |
|---|---|
| pre-effect rejection or definitely_not_mutated | Retry only after a fresh exact fence and a new attempt epoch |
| effect_confirmed | Do not repeat the effect; capture proof and settle |
| may_have_mutated | Confirm/read back only; no blind retry |
| may_have_mutated plus confirmed provider absence is impossible to prove | Escalate |
| lease expired but operation prepared and no effect attempted | Replacement worker may claim and execute after a fresh fence |
| lease replaced after provider call | Old worker cannot settle; replacement worker may only confirm the original operation |
| authority revision changed before effect | Reject this execution; create a new intent |
| authority revision changed after an effect | Settle only against the original exact execution if proof is available; never attach the effect to the new revision |
| database failed after provider mutation | Reconcile by operation identity/readback; settle only after durable proof |
| authority epoch crossed | Reject stale workers and require a new execution or deterministic confirmation of the old one |

No agent, provider adapter, or command handler chooses a recovery recipe. The kernel returns one of retry_before_effect, confirm_only, settle_confirmed, settle_no_effect, or escalate.

## Required failure proofs

The conformance suite will use an in-memory store plus a controllable provider capability, then repeat critical cases against PostgreSQL.

| Scenario | Required outcome |
|---|---|
| Worker dies before effect | Lease expires; replacement may claim; no effect or settlement is duplicated |
| Worker dies after effect before settlement | Replacement confirms the original operation and settles the same execution |
| Provider timeout with unknown status | operation becomes effect_uncertain/may_have_mutated; no blind retry |
| Same idempotency identity is delivered twice | One operation row and one provider effect; replay returns the durable outcome |
| Stale worker settles after lease replacement | Compare-and-set rejects it; newer execution remains untouched |
| Source revision changes after intent creation | Pre-effect fence rejects with no provider mutation |
| Evidence refers to another revision | Proof insert or settlement fails closed |
| Two workers race to claim | Database uniqueness/CAS yields one owner |
| Provider confirms effect already occurred | Readback moves to effect_confirmed; effect is not repeated |
| Database fails after provider mutation | Readback reconciles the exact operation; unresolved state escalates rather than guessing |
| Recovery sees may_have_mutated=true | Only confirmation is allowed |
| Execution crosses authority epoch | Old lease cannot invoke or settle; replacement/new intent is required |

Add a state-machine/property harness for duplicate delivery, reordered messages, crash points, replacement workers, and concurrent claims. Add a small contract suite for each provider capability and a limited number of end-to-end proofs for project.advance, production promotion, and release publication.

## Migration and deletion sequence

1. Freeze the current baseline and add characterization tests around compact execution_state, operation_state, proof_state, exact revision fencing, and existing safe recovery behavior.
2. Implement the TypeScript kernel values and transition functions first. Make the existing compact PostgreSQL behavior satisfy the new port; do not add a facade over old and new stores.
3. Add the minimum schema constraints/columns for execution_id, lifecycle, attempt_epoch, and exact proof binding. Keep changes additive until all callers use the kernel.
4. Move project-transition claim, checkpoint, heartbeat, effect, confirmation, and settlement to the kernel. Delete the atomic/legacy acquire branch after callers migrate.
5. Move GitHub changeset, branch mutation, PR readiness, release, promotion, and materialization callers to provider capabilities invoked by the kernel. Delete compact provider receipt stores and provider recovery wrappers.
6. Move project authoring and portfolio/work reconciliation to kernel intents. Make orchestration_runs correlation-only and remove correctness decisions from orchestration journal/recovery modules.
7. Migrate the GCP worker and transport wrappers to generated runtime output from TypeScript. Keep Hatchable free of semantic writes.
8. Remove legacy authority contracts, work lease APIs, separate project-transition lease APIs, evidence reconstruction, deterministic-work settlement, compatibility command exposure, and migration-era provider ceremony. Historical migration files remain only as schema history.
9. Add boundary tests and a source audit that fails if a provider or orchestration module imports lease, settlement, recovery, or mutation-certainty policy.
10. Run focused kernel/provider tests, full repository CI, exact-revision deployment verification, and final tree/grep inspection before declaring completion.

There is no intermediate state in which both old and new mechanisms are supported as equal authorities. Each migration step has one survivor and an explicit deletion.

## Metrics

The baseline snapshot was taken from the live repository before implementation work, with dev at 60603f7afac3a647a350fa077b4a1f2e8b6e9cba; the design was rechecked at ddc844dedab005ef54ac4e9892e7d84e44054b5b after the repository advanced.

The measurement script will count only production runtime/semantic files, not historical migrations or generated duplicates counted twice. It will record:

- production lines and bytes in execution-correctness modules;
- test lines and bytes for lifecycle protocol tests;
- distinct lease implementations;
- distinct recovery implementations;
- distinct settlement implementations;
- distinct mutation-certainty implementations;
- generic execution concepts implemented under provider-specific paths;
- compatibility modules still imported by production code;
- distinct lifecycle state enums/normalizers;
- active database tables read or written by correctness code.

The expected end state is one lease implementation, one recovery classifier, one settlement function, one mutation-certainty lattice, one lifecycle enum, and zero provider-specific generic protocol implementations. The final report must include the actual before/after counts rather than a target estimate.

## Graph obligations

The graph should describe obligations, not file movements or classes. The intended obligation set is:

- unified-execution-identity
- single-lease-authority
- central-mutation-certainty
- evidence-bound-settlement
- deterministic-recovery
- provider-semantic-thinness
- legacy-execution-path-elimination

A single umbrella transition may be used while the graph is being migrated, but it must carry these acceptance obligations and must not name a kernel class or a file move as its outcome. Once the graph authoring path is healthy, split or amend the umbrella only if that creates real independent settlement boundaries; otherwise keep one obligation so the graph does not recreate the code fragmentation being removed.

## Non-goals and safety constraints

- Do not weaken exact Git revision or provider object fencing.
- Do not let Hatchable regain semantic authority or become a database writer.
- Do not treat a provider success response as settlement.
- Do not allow an uncertain effect to be retried blindly.
- Do not allow stale workers to mutate or settle newer executions.
- Do not retain v1/v2 compatibility facades after migration.
- Do not replace typed state transitions with agent instructions.
- Do not make a framework-shaped KernelInterface/Adapter/Manager stack.
- Do not delete provider-specific safety that is required by GitHub or Cloud Run; move only generic transaction protocol out of provider modules.
- Do not add a database table without a concrete invariant it enforces.

This design preserves the existing authority boundary while making execution correctness mechanically inspectable in one place.
