# Contract authority atlas

Generated from contract evidence. Edit authoritative sources or classification metadata, not this file.

This atlas shows mechanically evidenced logical-contract authority and manifestations. It does not infer consumer or cross-contract flow relationships that the catalog does not encode.

## `compact.execution-state`

- Significance: `durable-internal`
- SemVer: `internal-module-layout`
- Authority: `typescript:src/semantic/compact-execution-state.ts#ExecutionState` (`typescript`)
- Authority source: `src/semantic/compact-execution-state.ts#ExecutionState`
- Manifestations: 40

### Projections

- `postgres:public.execution_state#active_capability_material` (`postgres`)
  - Source: `public.execution_state#active_capability_material`
- `postgres:public.execution_state#authority_epoch` (`postgres`)
  - Source: `public.execution_state#authority_epoch`
- `postgres:public.execution_state#authority_repository` (`postgres`)
  - Source: `public.execution_state#authority_repository`
- `postgres:public.execution_state#authority_revision` (`postgres`)
  - Source: `public.execution_state#authority_revision`
- `postgres:public.execution_state#checkpoint` (`postgres`)
  - Source: `public.execution_state#checkpoint`
- `postgres:public.execution_state#checkpoint_sha256` (`postgres`)
  - Source: `public.execution_state#checkpoint_sha256`
- `postgres:public.execution_state#constraint:execution_state_authority_epoch_check` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_authority_epoch_check`
- `postgres:public.execution_state#constraint:execution_state_check` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_check`
- `postgres:public.execution_state#constraint:execution_state_heartbeat_count_check` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_heartbeat_count_check`
- `postgres:public.execution_state#constraint:execution_state_lease_ref_key` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_lease_ref_key`
- `postgres:public.execution_state#constraint:execution_state_no_progress_streak_check` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_no_progress_streak_check`
- `postgres:public.execution_state#constraint:execution_state_pkey` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_pkey`
- `postgres:public.execution_state#constraint:execution_state_recent_progress_sha256_check` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_recent_progress_sha256_check`
- `postgres:public.execution_state#constraint:execution_state_recent_progress_sha256_check1` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_recent_progress_sha256_check1`
- `postgres:public.execution_state#constraint:execution_state_run_id_fkey` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_run_id_fkey`
- `postgres:public.execution_state#constraint:execution_state_subject_kind_check` (`postgres`)
  - Source: `public.execution_state#constraint:execution_state_subject_kind_check`
- `postgres:public.execution_state#continuation` (`postgres`)
  - Source: `public.execution_state#continuation`
- `postgres:public.execution_state#continuation_execution_fingerprint` (`postgres`)
  - Source: `public.execution_state#continuation_execution_fingerprint`
- `postgres:public.execution_state#continuation_sha256` (`postgres`)
  - Source: `public.execution_state#continuation_sha256`
- `postgres:public.execution_state#expires_at` (`postgres`)
  - Source: `public.execution_state#expires_at`
- `postgres:public.execution_state#graph_fingerprint` (`postgres`)
  - Source: `public.execution_state#graph_fingerprint`
- `postgres:public.execution_state#hard_expires_at` (`postgres`)
  - Source: `public.execution_state#hard_expires_at`
- `postgres:public.execution_state#heartbeat_count` (`postgres`)
  - Source: `public.execution_state#heartbeat_count`
- `postgres:public.execution_state#last_heartbeat_at` (`postgres`)
  - Source: `public.execution_state#last_heartbeat_at`
- `postgres:public.execution_state#lease_ref` (`postgres`)
  - Source: `public.execution_state#lease_ref`
- `postgres:public.execution_state#no_progress_streak` (`postgres`)
  - Source: `public.execution_state#no_progress_streak`
- `postgres:public.execution_state#project_ref` (`postgres`)
  - Source: `public.execution_state#project_ref`
- `postgres:public.execution_state#recent_progress_sha256` (`postgres`)
  - Source: `public.execution_state#recent_progress_sha256`
- `postgres:public.execution_state#run_id` (`postgres`)
  - Source: `public.execution_state#run_id`
- `postgres:public.execution_state#subject_key` (`postgres`)
  - Source: `public.execution_state#subject_key`
- `postgres:public.execution_state#subject_kind` (`postgres`)
  - Source: `public.execution_state#subject_kind`
- `postgres:public.execution_state#table` (`postgres`)
  - Source: `public.execution_state#table`
- `postgres:public.execution_state#transition_dependency_fingerprint` (`postgres`)
  - Source: `public.execution_state#transition_dependency_fingerprint`
- `postgres:public.execution_state#transition_id` (`postgres`)
  - Source: `public.execution_state#transition_id`
- `postgres:public.execution_state#transition_revision_fingerprint` (`postgres`)
  - Source: `public.execution_state#transition_revision_fingerprint`
- `postgres:public.execution_state#updated_at` (`postgres`)
  - Source: `public.execution_state#updated_at`
- `typescript:src/semantic/compact-execution-state.ts#ExecutionFence` (`typescript`)
  - Source: `src/semantic/compact-execution-state.ts#ExecutionFence`
- `typescript:src/semantic/compact-execution-state.ts#ExecutionSubjectKind` (`typescript`)
  - Source: `src/semantic/compact-execution-state.ts#ExecutionSubjectKind`
- `typescript:src/semantic/compact-execution-state.ts#ProgressHashWindow` (`typescript`)
  - Source: `src/semantic/compact-execution-state.ts#ProgressHashWindow`

## `compact.execution-state.store`

- Significance: `boundary-internal`
- SemVer: `adapter-layout`
- Authority: `typescript:src/ports/compact-execution-state-store.ts#CompactExecutionStateStore` (`typescript`)
- Authority source: `src/ports/compact-execution-state-store.ts#CompactExecutionStateStore`
- Manifestations: 10

### Projections

- `typescript:src/ports/compact-execution-state-store.ts#AcquireExecutionInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#AcquireExecutionInput`
- `typescript:src/ports/compact-execution-state-store.ts#CompactRunInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#CompactRunInput`
- `typescript:src/ports/compact-execution-state-store.ts#HeartbeatExecutionInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#HeartbeatExecutionInput`
- `typescript:src/ports/compact-execution-state-store.ts#MarkOperationIndeterminateInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#MarkOperationIndeterminateInput`
- `typescript:src/ports/compact-execution-state-store.ts#PrepareOperationInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#PrepareOperationInput`
- `typescript:src/ports/compact-execution-state-store.ts#PutProofInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#PutProofInput`
- `typescript:src/ports/compact-execution-state-store.ts#ResolveOperationInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#ResolveOperationInput`
- `typescript:src/ports/compact-execution-state-store.ts#SettleExecutionInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#SettleExecutionInput`
- `typescript:src/ports/compact-execution-state-store.ts#WriteCheckpointInput` (`typescript`)
  - Source: `src/ports/compact-execution-state-store.ts#WriteCheckpointInput`

## `compact.operation-state`

- Significance: `durable-internal`
- SemVer: `internal-module-layout`
- Authority: `typescript:src/semantic/compact-execution-state.ts#OperationState` (`typescript`)
- Authority source: `src/semantic/compact-execution-state.ts#OperationState`
- Manifestations: 34

### Projections

- `postgres:public.operation_state#authority_revision` (`postgres`)
  - Source: `public.operation_state#authority_revision`
- `postgres:public.operation_state#command` (`postgres`)
  - Source: `public.operation_state#command`
- `postgres:public.operation_state#constraint:operation_state_check` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_check`
- `postgres:public.operation_state#constraint:operation_state_check1` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_check1`
- `postgres:public.operation_state#constraint:operation_state_check2` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_check2`
- `postgres:public.operation_state#constraint:operation_state_check3` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_check3`
- `postgres:public.operation_state#constraint:operation_state_check4` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_check4`
- `postgres:public.operation_state#constraint:operation_state_command_idempotency_scope_idempotency_key_key` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_command_idempotency_scope_idempotency_key_key`
- `postgres:public.operation_state#constraint:operation_state_lease_epoch_check` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_lease_epoch_check`
- `postgres:public.operation_state#constraint:operation_state_pkey` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_pkey`
- `postgres:public.operation_state#constraint:operation_state_run_id_fkey` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_run_id_fkey`
- `postgres:public.operation_state#constraint:operation_state_state_check` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_state_check`
- `postgres:public.operation_state#constraint:operation_state_subject_key_fkey` (`postgres`)
  - Source: `public.operation_state#constraint:operation_state_subject_key_fkey`
- `postgres:public.operation_state#created_at` (`postgres`)
  - Source: `public.operation_state#created_at`
- `postgres:public.operation_state#effect_kind` (`postgres`)
  - Source: `public.operation_state#effect_kind`
- `postgres:public.operation_state#effect_ref` (`postgres`)
  - Source: `public.operation_state#effect_ref`
- `postgres:public.operation_state#effect_sha256` (`postgres`)
  - Source: `public.operation_state#effect_sha256`
- `postgres:public.operation_state#idempotency_key` (`postgres`)
  - Source: `public.operation_state#idempotency_key`
- `postgres:public.operation_state#idempotency_scope` (`postgres`)
  - Source: `public.operation_state#idempotency_scope`
- `postgres:public.operation_state#lease_epoch` (`postgres`)
  - Source: `public.operation_state#lease_epoch`
- `postgres:public.operation_state#may_have_mutated` (`postgres`)
  - Source: `public.operation_state#may_have_mutated`
- `postgres:public.operation_state#operation_id` (`postgres`)
  - Source: `public.operation_state#operation_id`
- `postgres:public.operation_state#recovery_payload` (`postgres`)
  - Source: `public.operation_state#recovery_payload`
- `postgres:public.operation_state#request_sha256` (`postgres`)
  - Source: `public.operation_state#request_sha256`
- `postgres:public.operation_state#resolution` (`postgres`)
  - Source: `public.operation_state#resolution`
- `postgres:public.operation_state#resolved_at` (`postgres`)
  - Source: `public.operation_state#resolved_at`
- `postgres:public.operation_state#result_sha256` (`postgres`)
  - Source: `public.operation_state#result_sha256`
- `postgres:public.operation_state#run_id` (`postgres`)
  - Source: `public.operation_state#run_id`
- `postgres:public.operation_state#state` (`postgres`)
  - Source: `public.operation_state#state`
- `postgres:public.operation_state#subject_key` (`postgres`)
  - Source: `public.operation_state#subject_key`
- `postgres:public.operation_state#table` (`postgres`)
  - Source: `public.operation_state#table`
- `postgres:public.operation_state#updated_at` (`postgres`)
  - Source: `public.operation_state#updated_at`
- `typescript:src/semantic/compact-execution-state.ts#OperationLifecycleState` (`typescript`)
  - Source: `src/semantic/compact-execution-state.ts#OperationLifecycleState`

## `compact.proof-state`

- Significance: `durable-internal`
- SemVer: `internal-module-layout`
- Authority: `typescript:src/semantic/compact-execution-state.ts#ProofState` (`typescript`)
- Authority source: `src/semantic/compact-execution-state.ts#ProofState`
- Manifestations: 14

### Projections

- `postgres:public.proof_state#authority_repository` (`postgres`)
  - Source: `public.proof_state#authority_repository`
- `postgres:public.proof_state#authority_revision` (`postgres`)
  - Source: `public.proof_state#authority_revision`
- `postgres:public.proof_state#constraint:proof_state_evidence_refs_check` (`postgres`)
  - Source: `public.proof_state#constraint:proof_state_evidence_refs_check`
- `postgres:public.proof_state#constraint:proof_state_pkey` (`postgres`)
  - Source: `public.proof_state#constraint:proof_state_pkey`
- `postgres:public.proof_state#consumed_at` (`postgres`)
  - Source: `public.proof_state#consumed_at`
- `postgres:public.proof_state#evidence_refs` (`postgres`)
  - Source: `public.proof_state#evidence_refs`
- `postgres:public.proof_state#evidence_sha256` (`postgres`)
  - Source: `public.proof_state#evidence_sha256`
- `postgres:public.proof_state#predicate_kind` (`postgres`)
  - Source: `public.proof_state#predicate_kind`
- `postgres:public.proof_state#proof_key` (`postgres`)
  - Source: `public.proof_state#proof_key`
- `postgres:public.proof_state#satisfied_at` (`postgres`)
  - Source: `public.proof_state#satisfied_at`
- `postgres:public.proof_state#subject_key` (`postgres`)
  - Source: `public.proof_state#subject_key`
- `postgres:public.proof_state#table` (`postgres`)
  - Source: `public.proof_state#table`
- `typescript:src/semantic/compact-execution-state.ts#ProofEvidenceRef` (`typescript`)
  - Source: `src/semantic/compact-execution-state.ts#ProofEvidenceRef`

## `execution.authority.locator`

- Significance: `authority`
- Authority: `typescript:src/semantic/execution-authority-contracts.ts#ExecutionAuthorityLocator` (`typescript`)
- Authority source: `src/semantic/execution-authority-contracts.ts#ExecutionAuthorityLocator`
- Manifestations: 1

### Projections

_None._

## `execution.authority.project-transition`

- Significance: `authority`
- Authority: `typescript:src/semantic/execution-authority-contracts.ts#ProjectTransitionExecutionAuthority` (`typescript`)
- Authority source: `src/semantic/execution-authority-contracts.ts#ProjectTransitionExecutionAuthority`
- Manifestations: 1

### Projections

_None._

## `execution.authority.store-port`

- Significance: `boundary-internal`
- Authority: `typescript:src/semantic/execution-authority-contracts.ts#ExecutionAuthorityStore` (`typescript`)
- Authority source: `src/semantic/execution-authority-contracts.ts#ExecutionAuthorityStore`
- Manifestations: 1

### Projections

_None._

## `execution.evidence`

- Significance: `public`
- SemVer: `public-evidence-schema`
- Authority: `typescript:src/semantic/execution-evidence-contracts.ts#ExecutionEvidence` (`typescript`)
- Authority source: `src/semantic/execution-evidence-contracts.ts#ExecutionEvidence`
- Manifestations: 1

### Projections

_None._

## `execution.evidence.internals`

- Significance: `implementation-only`
- Authority: `typescript:src/semantic/execution-evidence.ts#executionEvidenceInternals` (`typescript`)
- Authority source: `src/semantic/execution-evidence.ts#executionEvidenceInternals`
- Manifestations: 2

### Projections

- `javascript:lib/execution-evidence.js#executionEvidenceInternals` (`javascript`)
  - Source: `lib/execution-evidence.js#executionEvidenceInternals`

## `execution.lifecycle.operating-conditions`

- Significance: `authority`
- SemVer: `lifecycle-semantics`
- Authority: `typescript:src/semantic/execution-lifecycle-contracts.ts#OPERATING_CONDITIONS` (`typescript`)
- Authority source: `src/semantic/execution-lifecycle-contracts.ts#OPERATING_CONDITIONS`
- Manifestations: 2

### Projections

- `javascript:lib/execution-lifecycle-contracts.js#OPERATING_CONDITIONS` (`javascript`)
  - Source: `lib/execution-lifecycle-contracts.js#OPERATING_CONDITIONS`

## `execution.lifecycle.productive-stages`

- Significance: `authority`
- SemVer: `lifecycle-semantics`
- Authority: `typescript:src/semantic/execution-lifecycle-contracts.ts#PRODUCTIVE_STAGES` (`typescript`)
- Authority source: `src/semantic/execution-lifecycle-contracts.ts#PRODUCTIVE_STAGES`
- Manifestations: 2

### Projections

- `javascript:lib/execution-lifecycle-contracts.js#PRODUCTIVE_STAGES` (`javascript`)
  - Source: `lib/execution-lifecycle-contracts.js#PRODUCTIVE_STAGES`

## `execution.lifecycle.work-settlement-dispositions`

- Significance: `authority`
- SemVer: `lifecycle-semantics`
- Authority: `typescript:src/semantic/execution-lifecycle-contracts.ts#WORK_SETTLEMENT_DISPOSITIONS` (`typescript`)
- Authority source: `src/semantic/execution-lifecycle-contracts.ts#WORK_SETTLEMENT_DISPOSITIONS`
- Manifestations: 2

### Projections

- `javascript:lib/execution-lifecycle-contracts.js#WORK_SETTLEMENT_DISPOSITIONS` (`javascript`)
  - Source: `lib/execution-lifecycle-contracts.js#WORK_SETTLEMENT_DISPOSITIONS`

## `execution.store.lease`

- Significance: `durable-internal`
- Authority: `typescript:src/semantic/execution-authority-contracts.ts#StoredExecutionLease` (`typescript`)
- Authority source: `src/semantic/execution-authority-contracts.ts#StoredExecutionLease`
- Manifestations: 1

### Projections

_None._

## `execution.store.run`

- Significance: `durable-internal`
- Authority: `typescript:src/semantic/execution-authority-contracts.ts#StoredExecutionRun` (`typescript`)
- Authority source: `src/semantic/execution-authority-contracts.ts#StoredExecutionRun`
- Manifestations: 1

### Projections

_None._

## `execution.store.slot`

- Significance: `durable-internal`
- Authority: `typescript:src/semantic/execution-authority-contracts.ts#StoredExecutionSlot` (`typescript`)
- Authority source: `src/semantic/execution-authority-contracts.ts#StoredExecutionSlot`
- Manifestations: 1

### Projections

_None._

## `github.changeset-receipt.persistence`

- Significance: `durable-internal`
- SemVer: `database-layout`
- Authority: `postgres:public.github_changeset_receipts#table` (`postgres`)
- Authority source: `public.github_changeset_receipts#table`
- Manifestations: 21

### Projections

- `postgres:public.github_changeset_receipts#attempt_token` (`postgres`)
  - Source: `public.github_changeset_receipts#attempt_token`
- `postgres:public.github_changeset_receipts#base_sha` (`postgres`)
  - Source: `public.github_changeset_receipts#base_sha`
- `postgres:public.github_changeset_receipts#branch` (`postgres`)
  - Source: `public.github_changeset_receipts#branch`
- `postgres:public.github_changeset_receipts#changed_paths` (`postgres`)
  - Source: `public.github_changeset_receipts#changed_paths`
- `postgres:public.github_changeset_receipts#commit_sha` (`postgres`)
  - Source: `public.github_changeset_receipts#commit_sha`
- `postgres:public.github_changeset_receipts#constraint:github_changeset_receipts_pkey` (`postgres`)
  - Source: `public.github_changeset_receipts#constraint:github_changeset_receipts_pkey`
- `postgres:public.github_changeset_receipts#constraint:github_changeset_receipts_request_sha256_check` (`postgres`)
  - Source: `public.github_changeset_receipts#constraint:github_changeset_receipts_request_sha256_check`
- `postgres:public.github_changeset_receipts#constraint:github_changeset_receipts_state_check` (`postgres`)
  - Source: `public.github_changeset_receipts#constraint:github_changeset_receipts_state_check`
- `postgres:public.github_changeset_receipts#created_at` (`postgres`)
  - Source: `public.github_changeset_receipts#created_at`
- `postgres:public.github_changeset_receipts#created_branch` (`postgres`)
  - Source: `public.github_changeset_receipts#created_branch`
- `postgres:public.github_changeset_receipts#idempotency_key` (`postgres`)
  - Source: `public.github_changeset_receipts#idempotency_key`
- `postgres:public.github_changeset_receipts#old_head` (`postgres`)
  - Source: `public.github_changeset_receipts#old_head`
- `postgres:public.github_changeset_receipts#precondition_verified` (`postgres`)
  - Source: `public.github_changeset_receipts#precondition_verified`
- `postgres:public.github_changeset_receipts#receipt` (`postgres`)
  - Source: `public.github_changeset_receipts#receipt`
- `postgres:public.github_changeset_receipts#repo` (`postgres`)
  - Source: `public.github_changeset_receipts#repo`
- `postgres:public.github_changeset_receipts#request_json` (`postgres`)
  - Source: `public.github_changeset_receipts#request_json`
- `postgres:public.github_changeset_receipts#request_sha256` (`postgres`)
  - Source: `public.github_changeset_receipts#request_sha256`
- `postgres:public.github_changeset_receipts#state` (`postgres`)
  - Source: `public.github_changeset_receipts#state`
- `postgres:public.github_changeset_receipts#tree_sha` (`postgres`)
  - Source: `public.github_changeset_receipts#tree_sha`
- `postgres:public.github_changeset_receipts#updated_at` (`postgres`)
  - Source: `public.github_changeset_receipts#updated_at`

## `github.production-promotion-receipt.persistence`

- Significance: `durable-internal`
- SemVer: `database-layout`
- Authority: `postgres:public.github_production_promotion_receipts#table` (`postgres`)
- Authority source: `public.github_production_promotion_receipts#table`
- Manifestations: 16

### Projections

- `postgres:public.github_production_promotion_receipts#attempt_token` (`postgres`)
  - Source: `public.github_production_promotion_receipts#attempt_token`
- `postgres:public.github_production_promotion_receipts#candidate_sha` (`postgres`)
  - Source: `public.github_production_promotion_receipts#candidate_sha`
- `postgres:public.github_production_promotion_receipts#constraint:github_production_promotion_receipts_pkey` (`postgres`)
  - Source: `public.github_production_promotion_receipts#constraint:github_production_promotion_receipts_pkey`
- `postgres:public.github_production_promotion_receipts#created_at` (`postgres`)
  - Source: `public.github_production_promotion_receipts#created_at`
- `postgres:public.github_production_promotion_receipts#idempotency_key` (`postgres`)
  - Source: `public.github_production_promotion_receipts#idempotency_key`
- `postgres:public.github_production_promotion_receipts#last_error` (`postgres`)
  - Source: `public.github_production_promotion_receipts#last_error`
- `postgres:public.github_production_promotion_receipts#new_production_head` (`postgres`)
  - Source: `public.github_production_promotion_receipts#new_production_head`
- `postgres:public.github_production_promotion_receipts#old_production_head` (`postgres`)
  - Source: `public.github_production_promotion_receipts#old_production_head`
- `postgres:public.github_production_promotion_receipts#receipt` (`postgres`)
  - Source: `public.github_production_promotion_receipts#receipt`
- `postgres:public.github_production_promotion_receipts#repo` (`postgres`)
  - Source: `public.github_production_promotion_receipts#repo`
- `postgres:public.github_production_promotion_receipts#request_json` (`postgres`)
  - Source: `public.github_production_promotion_receipts#request_json`
- `postgres:public.github_production_promotion_receipts#request_sha256` (`postgres`)
  - Source: `public.github_production_promotion_receipts#request_sha256`
- `postgres:public.github_production_promotion_receipts#state` (`postgres`)
  - Source: `public.github_production_promotion_receipts#state`
- `postgres:public.github_production_promotion_receipts#updated_at` (`postgres`)
  - Source: `public.github_production_promotion_receipts#updated_at`
- `postgres:public.github_production_promotion_receipts#verification_run_id` (`postgres`)
  - Source: `public.github_production_promotion_receipts#verification_run_id`

## `github.release-receipt.persistence`

- Significance: `durable-internal`
- SemVer: `database-layout`
- Authority: `postgres:public.github_release_receipts#table` (`postgres`)
- Authority source: `public.github_release_receipts#table`
- Manifestations: 19

### Projections

- `postgres:public.github_release_receipts#attempt_token` (`postgres`)
  - Source: `public.github_release_receipts#attempt_token`
- `postgres:public.github_release_receipts#constraint:github_release_receipts_pkey` (`postgres`)
  - Source: `public.github_release_receipts#constraint:github_release_receipts_pkey`
- `postgres:public.github_release_receipts#constraint:github_release_receipts_state_check` (`postgres`)
  - Source: `public.github_release_receipts#constraint:github_release_receipts_state_check`
- `postgres:public.github_release_receipts#created_at` (`postgres`)
  - Source: `public.github_release_receipts#created_at`
- `postgres:public.github_release_receipts#idempotency_key` (`postgres`)
  - Source: `public.github_release_receipts#idempotency_key`
- `postgres:public.github_release_receipts#last_error` (`postgres`)
  - Source: `public.github_release_receipts#last_error`
- `postgres:public.github_release_receipts#receipt` (`postgres`)
  - Source: `public.github_release_receipts#receipt`
- `postgres:public.github_release_receipts#release_id` (`postgres`)
  - Source: `public.github_release_receipts#release_id`
- `postgres:public.github_release_receipts#release_may_exist` (`postgres`)
  - Source: `public.github_release_receipts#release_may_exist`
- `postgres:public.github_release_receipts#repo` (`postgres`)
  - Source: `public.github_release_receipts#repo`
- `postgres:public.github_release_receipts#request_json` (`postgres`)
  - Source: `public.github_release_receipts#request_json`
- `postgres:public.github_release_receipts#request_sha256` (`postgres`)
  - Source: `public.github_release_receipts#request_sha256`
- `postgres:public.github_release_receipts#state` (`postgres`)
  - Source: `public.github_release_receipts#state`
- `postgres:public.github_release_receipts#tag_created` (`postgres`)
  - Source: `public.github_release_receipts#tag_created`
- `postgres:public.github_release_receipts#tag_name` (`postgres`)
  - Source: `public.github_release_receipts#tag_name`
- `postgres:public.github_release_receipts#tag_ref_node_id` (`postgres`)
  - Source: `public.github_release_receipts#tag_ref_node_id`
- `postgres:public.github_release_receipts#target_sha` (`postgres`)
  - Source: `public.github_release_receipts#target_sha`
- `postgres:public.github_release_receipts#updated_at` (`postgres`)
  - Source: `public.github_release_receipts#updated_at`

## `github.release.create.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:github.release.create#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#github.release.create`
- Manifestations: 1

### Projections

_None._

## `orchestration.command-invocation.persistence`

- Significance: `durable-internal`
- SemVer: `database-layout`
- Authority: `postgres:public.orchestration_command_invocations#table` (`postgres`)
- Authority source: `public.orchestration_command_invocations#table`
- Manifestations: 23

### Projections

- `postgres:public.orchestration_command_invocations#command` (`postgres`)
  - Source: `public.orchestration_command_invocations#command`
- `postgres:public.orchestration_command_invocations#completed_at` (`postgres`)
  - Source: `public.orchestration_command_invocations#completed_at`
- `postgres:public.orchestration_command_invocations#constraint:orchestration_command_invocations_outcome_check` (`postgres`)
  - Source: `public.orchestration_command_invocations#constraint:orchestration_command_invocations_outcome_check`
- `postgres:public.orchestration_command_invocations#constraint:orchestration_command_invocations_pkey` (`postgres`)
  - Source: `public.orchestration_command_invocations#constraint:orchestration_command_invocations_pkey`
- `postgres:public.orchestration_command_invocations#error_class` (`postgres`)
  - Source: `public.orchestration_command_invocations#error_class`
- `postgres:public.orchestration_command_invocations#error_code` (`postgres`)
  - Source: `public.orchestration_command_invocations#error_code`
- `postgres:public.orchestration_command_invocations#idempotency_key` (`postgres`)
  - Source: `public.orchestration_command_invocations#idempotency_key`
- `postgres:public.orchestration_command_invocations#invocation_id` (`postgres`)
  - Source: `public.orchestration_command_invocations#invocation_id`
- `postgres:public.orchestration_command_invocations#may_have_mutated` (`postgres`)
  - Source: `public.orchestration_command_invocations#may_have_mutated`
- `postgres:public.orchestration_command_invocations#outcome` (`postgres`)
  - Source: `public.orchestration_command_invocations#outcome`
- `postgres:public.orchestration_command_invocations#rejection` (`postgres`)
  - Source: `public.orchestration_command_invocations#rejection`
- `postgres:public.orchestration_command_invocations#request_projection` (`postgres`)
  - Source: `public.orchestration_command_invocations#request_projection`
- `postgres:public.orchestration_command_invocations#request_sha256` (`postgres`)
  - Source: `public.orchestration_command_invocations#request_sha256`
- `postgres:public.orchestration_command_invocations#result_projection` (`postgres`)
  - Source: `public.orchestration_command_invocations#result_projection`
- `postgres:public.orchestration_command_invocations#result_sha256` (`postgres`)
  - Source: `public.orchestration_command_invocations#result_sha256`
- `postgres:public.orchestration_command_invocations#retryable` (`postgres`)
  - Source: `public.orchestration_command_invocations#retryable`
- `postgres:public.orchestration_command_invocations#run_id` (`postgres`)
  - Source: `public.orchestration_command_invocations#run_id`
- `postgres:public.orchestration_command_invocations#schema_version` (`postgres`)
  - Source: `public.orchestration_command_invocations#schema_version`
- `postgres:public.orchestration_command_invocations#sequence` (`postgres`)
  - Source: `public.orchestration_command_invocations#sequence`
- `postgres:public.orchestration_command_invocations#started_at` (`postgres`)
  - Source: `public.orchestration_command_invocations#started_at`
- `postgres:public.orchestration_command_invocations#target_kind` (`postgres`)
  - Source: `public.orchestration_command_invocations#target_kind`
- `postgres:public.orchestration_command_invocations#target_ref` (`postgres`)
  - Source: `public.orchestration_command_invocations#target_ref`

## `orchestration.current-failure-internals`

- Significance: `implementation-only`
- SemVer: `internal-module-layout`
- Authority: `javascript:lib/orchestration-current-failure.js#orchestrationCurrentFailureInternals` (`javascript`)
- Authority source: `lib/orchestration-current-failure.js#orchestrationCurrentFailureInternals`
- Manifestations: 1

### Projections

_None._

## `orchestration.diagnose.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:orchestration.diagnose#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#orchestration.diagnose`
- Manifestations: 1

### Projections

_None._

## `orchestration.run.persistence`

- Significance: `durable-internal`
- SemVer: `database-layout`
- Authority: `postgres:public.orchestration_runs#table` (`postgres`)
- Authority source: `public.orchestration_runs#table`
- Manifestations: 46

### Projections

- `postgres:public.orchestration_runs#active_subject_key` (`postgres`)
  - Source: `public.orchestration_runs#active_subject_key`
- `postgres:public.orchestration_runs#base_start_request_sha256` (`postgres`)
  - Source: `public.orchestration_runs#base_start_request_sha256`
- `postgres:public.orchestration_runs#constraint:orchestration_runs_active_subject_key_fkey` (`postgres`)
  - Source: `public.orchestration_runs#constraint:orchestration_runs_active_subject_key_fkey`
- `postgres:public.orchestration_runs#constraint:orchestration_runs_current_failure_check` (`postgres`)
  - Source: `public.orchestration_runs#constraint:orchestration_runs_current_failure_check`
- `postgres:public.orchestration_runs#constraint:orchestration_runs_pkey` (`postgres`)
  - Source: `public.orchestration_runs#constraint:orchestration_runs_pkey`
- `postgres:public.orchestration_runs#constraint:orchestration_runs_target_identity_check` (`postgres`)
  - Source: `public.orchestration_runs#constraint:orchestration_runs_target_identity_check`
- `postgres:public.orchestration_runs#constraint:orchestration_runs_unresolved_operation_id_fkey` (`postgres`)
  - Source: `public.orchestration_runs#constraint:orchestration_runs_unresolved_operation_id_fkey`
- `postgres:public.orchestration_runs#continuation_key` (`postgres`)
  - Source: `public.orchestration_runs#continuation_key`
- `postgres:public.orchestration_runs#contract_provenance` (`postgres`)
  - Source: `public.orchestration_runs#contract_provenance`
- `postgres:public.orchestration_runs#current_failure_command` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_command`
- `postgres:public.orchestration_runs#current_failure_error_class` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_error_class`
- `postgres:public.orchestration_runs#current_failure_error_code` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_error_code`
- `postgres:public.orchestration_runs#current_failure_may_have_mutated` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_may_have_mutated`
- `postgres:public.orchestration_runs#current_failure_rejection` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_rejection`
- `postgres:public.orchestration_runs#current_failure_retryable` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_retryable`
- `postgres:public.orchestration_runs#current_failure_streak` (`postgres`)
  - Source: `public.orchestration_runs#current_failure_streak`
- `postgres:public.orchestration_runs#deadline_at` (`postgres`)
  - Source: `public.orchestration_runs#deadline_at`
- `postgres:public.orchestration_runs#disposition` (`postgres`)
  - Source: `public.orchestration_runs#disposition`
- `postgres:public.orchestration_runs#final_effect_refs` (`postgres`)
  - Source: `public.orchestration_runs#final_effect_refs`
- `postgres:public.orchestration_runs#final_evidence_sha256` (`postgres`)
  - Source: `public.orchestration_runs#final_evidence_sha256`
- `postgres:public.orchestration_runs#finish_request_sha256` (`postgres`)
  - Source: `public.orchestration_runs#finish_request_sha256`
- `postgres:public.orchestration_runs#finished_at` (`postgres`)
  - Source: `public.orchestration_runs#finished_at`
- `postgres:public.orchestration_runs#last_durable_activity_at` (`postgres`)
  - Source: `public.orchestration_runs#last_durable_activity_at`
- `postgres:public.orchestration_runs#last_durable_activity_sequence` (`postgres`)
  - Source: `public.orchestration_runs#last_durable_activity_sequence`
- `postgres:public.orchestration_runs#last_durable_activity_type` (`postgres`)
  - Source: `public.orchestration_runs#last_durable_activity_type`
- `postgres:public.orchestration_runs#last_gate` (`postgres`)
  - Source: `public.orchestration_runs#last_gate`
- `postgres:public.orchestration_runs#last_work_ref` (`postgres`)
  - Source: `public.orchestration_runs#last_work_ref`
- `postgres:public.orchestration_runs#latest_horizon_id` (`postgres`)
  - Source: `public.orchestration_runs#latest_horizon_id`
- `postgres:public.orchestration_runs#minimum_new_gate_seconds` (`postgres`)
  - Source: `public.orchestration_runs#minimum_new_gate_seconds`
- `postgres:public.orchestration_runs#mode` (`postgres`)
  - Source: `public.orchestration_runs#mode`
- `postgres:public.orchestration_runs#predecessor_run_id` (`postgres`)
  - Source: `public.orchestration_runs#predecessor_run_id`
- `postgres:public.orchestration_runs#run_id` (`postgres`)
  - Source: `public.orchestration_runs#run_id`
- `postgres:public.orchestration_runs#scope` (`postgres`)
  - Source: `public.orchestration_runs#scope`
- `postgres:public.orchestration_runs#scope_sha256` (`postgres`)
  - Source: `public.orchestration_runs#scope_sha256`
- `postgres:public.orchestration_runs#settlement_reserve_seconds` (`postgres`)
  - Source: `public.orchestration_runs#settlement_reserve_seconds`
- `postgres:public.orchestration_runs#skill_policy` (`postgres`)
  - Source: `public.orchestration_runs#skill_policy`
- `postgres:public.orchestration_runs#start_request_sha256` (`postgres`)
  - Source: `public.orchestration_runs#start_request_sha256`
- `postgres:public.orchestration_runs#started_at` (`postgres`)
  - Source: `public.orchestration_runs#started_at`
- `postgres:public.orchestration_runs#status` (`postgres`)
  - Source: `public.orchestration_runs#status`
- `postgres:public.orchestration_runs#stop_reason` (`postgres`)
  - Source: `public.orchestration_runs#stop_reason`
- `postgres:public.orchestration_runs#target` (`postgres`)
  - Source: `public.orchestration_runs#target`
- `postgres:public.orchestration_runs#target_sha256` (`postgres`)
  - Source: `public.orchestration_runs#target_sha256`
- `postgres:public.orchestration_runs#unresolved_operation_id` (`postgres`)
  - Source: `public.orchestration_runs#unresolved_operation_id`
- `postgres:public.orchestration_runs#updated_at` (`postgres`)
  - Source: `public.orchestration_runs#updated_at`
- `postgres:public.orchestration_runs#worker` (`postgres`)
  - Source: `public.orchestration_runs#worker`

## `postgres.transaction-executor`

- Significance: `implementation-only`
- SemVer: `runtime-host-detail`
- Authority: `typescript:src/adapters/postgres/node-postgres-runtime.ts#NodePostgresTransactionExecutor` (`typescript`)
- Authority source: `src/adapters/postgres/node-postgres-runtime.ts#NodePostgresTransactionExecutor`
- Manifestations: 1

### Projections

_None._

## `production.promote.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:production.promote#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#production.promote`
- Manifestations: 2

### Projections

- `mcp:mcp/production.promote.js#inputSchema` (`mcp`)
  - Source: `mcp/production.promote.js#inputSchema`

## `project.advance.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:project.advance#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#project.advance`
- Manifestations: 2

### Projections

- `mcp:mcp/project.advance.js#inputSchema` (`mcp`)
  - Source: `mcp/project.advance.js#inputSchema`

## `project.advance.runtime-host`

- Significance: `boundary-internal`
- Authority: `typescript:src/ports/project-advance-runtime-host.ts#ProjectAdvanceRuntimeHost` (`typescript`)
- Authority source: `src/ports/project-advance-runtime-host.ts#ProjectAdvanceRuntimeHost`
- Manifestations: 1

### Projections

_None._

## `project.amend.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:project.amend#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#project.amend`
- Manifestations: 2

### Projections

- `mcp:mcp/project.amend.js#inputSchema` (`mcp`)
  - Source: `mcp/project.amend.js#inputSchema`

## `project.define.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:project.define#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#project.define`
- Manifestations: 2

### Projections

- `mcp:mcp/project.define.js#inputSchema` (`mcp`)
  - Source: `mcp/project.define.js#inputSchema`

## `project.graph.authority-coordinate`

- Significance: `authority`
- Authority: `typescript:src/semantic/project-graph-reconciliation.ts#ProjectGraphAuthorityCoordinate` (`typescript`)
- Authority source: `src/semantic/project-graph-reconciliation.ts#ProjectGraphAuthorityCoordinate`
- Manifestations: 1

### Projections

_None._

## `project.inspect.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:project.inspect#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#project.inspect`
- Manifestations: 2

### Projections

- `mcp:mcp/project.inspect.js#inputSchema` (`mcp`)
  - Source: `mcp/project.inspect.js#inputSchema`

## `project.transition.states`

- Significance: `authority`
- SemVer: `lifecycle-semantics`
- Authority: `typescript:src/semantic/project-transition-status-contracts.ts#PROJECT_TRANSITION_STATES` (`typescript`)
- Authority source: `src/semantic/project-transition-status-contracts.ts#PROJECT_TRANSITION_STATES`
- Manifestations: 1

### Projections

_None._

## `release.publish.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:release.publish#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#release.publish`
- Manifestations: 2

### Projections

- `mcp:mcp/release.publish.js#inputSchema` (`mcp`)
  - Source: `mcp/release.publish.js#inputSchema`

## `work.settle.input`

- Significance: `public`
- SemVer: `semantic-command-contract`
- Authority: `semantic-command:work.settle#input` (`semantic-command`)
- Authority source: `src/semantic/semantic-command-descriptors.ts#work.settle`
- Manifestations: 1

### Projections

_None._
