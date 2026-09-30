-- Physical realization of the desired architecture for this repository revision.
--
-- This file may name source artifacts, symbols, workflows, jobs, and provider
-- operations. It binds the logical architecture to the current implementation.

INSERT INTO artifact(artifact_id) VALUES
  ('.github/workflows/codex-closed-loop.yml'),
  ('.github/workflows/disposable-agent-proof.yml'),
  ('.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/github-object-transport-proof.yml'),
  ('.github/workflows/operator-project-advance.yml'),
  ('.github/workflows/operator-project-submit.yml'),
  ('.github/workflows/production-criticality-mutation-probe.yml'),
  ('.github/workflows/production-latency.yml'),
  ('.github/workflows/promote-criticality-mutation-evidence.yml'),
  ('.github/workflows/substrate-capability-admission-treatment.yml'),
  ('.github/workflows/substrate-capability-admission.yml'),
  ('src/authority/engine.ts'),
  ('src/authority/facts.ts'),
  ('src/authority/project-state.ts'),
  ('src/authority/replay.ts'),
  ('src/authority/store.ts'),
  ('src/authority/transaction-admission.ts'),
  ('src/digest.ts'),
  ('src/effect-release-witness.ts'),
  ('src/observation/observe.ts'),
  ('src/providers/github/certified-status.ts'),
  ('src/providers/github/comment-attestation.ts'),
  ('src/providers/github/pr-update-branch-effect.ts'),
  ('src/providers/github/status-effect.ts'),
  ('src/providers/kubernetes/configmap-effect.ts'),
  ('src/source/source-integration.ts'),
  ('src/semantics.ts'),
  ('src/storage/sqlite.ts'),
  ('test/digest-pure.test.ts'),
  ('test/projection-reconstruction.test.ts'),
  ('test/projector-pure.test.ts'),
  ('test/provider-observation.test.ts'),
  ('test/github-comment-attestation.test.ts'),
  ('test/trusted-effect-core-loop.test.ts');

INSERT INTO symbol(symbol_id, artifact_id) VALUES
  ('canonicalDigest', 'src/digest.ts'),
  ('validateAuthorityFact', 'src/authority/facts.ts'),
  ('deriveProjectProjection', 'src/authority/project-state.ts'),
  ('observePostcondition', 'src/observation/observe.ts'),
  ('KernelCore.claim', 'src/authority/engine.ts'),
  ('KernelCore.acquireExecution', 'src/authority/engine.ts'),
  ('KernelCore.authorizeEffect', 'src/authority/engine.ts'),
  ('KernelCore.beginEffect', 'src/authority/engine.ts'),
  ('KernelCore.performEffect', 'src/authority/engine.ts'),
  ('KernelCore.releaseEffectReservation', 'src/authority/engine.ts'),
  ('KernelCore.resolve', 'src/authority/engine.ts'),
  ('replayProjection', 'src/authority/replay.ts'),
  ('DurableFactStore.head', 'src/authority/store.ts'),
  ('DurableFactStore.append', 'src/authority/store.ts'),
  ('DurableFactStore.history', 'src/authority/store.ts'),
  ('mutationAdmitted', 'src/authority/transaction-admission.ts'),
  ('validateEffectReleaseEvidence', 'src/effect-release-witness.ts'),
  ('settlementSemantics', 'src/semantics.ts'),
  ('SqliteFactStore.head', 'src/storage/sqlite.ts'),
  ('SqliteFactStore.append', 'src/storage/sqlite.ts'),
  ('SqliteFactStore.history', 'src/storage/sqlite.ts'),
  ('observationVerified', 'src/observation/observe.ts'),
  ('observeSourceIntegration', 'src/source/source-integration.ts'),
  ('performPreparedSourceIntegration', 'src/source/source-integration.ts'),
  ('observeCertifiedGitHubCommitStatus', 'src/providers/github/certified-status.ts'),
  ('observeCertifiedGitHubIssueCommentAttestation', 'src/providers/github/comment-attestation.ts'),
  ('performGitHubCommitStatusEffect', 'src/providers/github/status-effect.ts'),
  ('performGitHubPullRequestUpdateBranchEffect', 'src/providers/github/pr-update-branch-effect.ts'),
  ('performKubernetesConfigMapEffect', 'src/providers/kubernetes/configmap-effect.ts');

INSERT INTO symbol_implements_authority(symbol_id, authority_id) VALUES
  ('KernelCore.claim', 'project-authority'),
  ('KernelCore.acquireExecution', 'execution-authority'),
  ('KernelCore.authorizeEffect', 'effect-authority');

INSERT INTO symbol_implements_capability(symbol_id, capability_id) VALUES
  ('canonicalDigest', 'canonical-content-identity'),
  ('validateAuthorityFact', 'durable-project-facts'),
  ('replayProjection', 'durable-project-facts'),
  ('SqliteFactStore.head', 'durable-project-facts'),
  ('SqliteFactStore.append', 'durable-project-facts'),
  ('SqliteFactStore.history', 'durable-project-facts'),
  ('deriveProjectProjection', 'project-lifecycle-projection'),
  ('observePostcondition', 'authoritative-observation'),
  ('observationVerified', 'authoritative-observation'),
  ('KernelCore.authorizeEffect', 'effect-authorization'),
  ('mutationAdmitted', 'effect-authorization'),
  ('KernelCore.beginEffect', 'effect-reservation'),
  ('validateEffectReleaseEvidence', 'effect-reservation'),
  ('KernelCore.performEffect', 'effect-execution'),
  ('KernelCore.releaseEffectReservation', 'effect-release'),
  ('KernelCore.resolve', 'effect-settlement'),
  ('settlementSemantics', 'effect-settlement'),
  ('observeSourceIntegration', 'authoritative-observation'),
  ('performGitHubCommitStatusEffect', 'github-commit-status-mutation'),
  ('observeCertifiedGitHubCommitStatus', 'github-commit-status-observation'),
  ('observeCertifiedGitHubIssueCommentAttestation', 'judgment-attestation-observation');

INSERT INTO symbol_projects_capability(symbol_id, capability_id) VALUES
  ('deriveProjectProjection', 'durable-project-facts'),
  ('deriveProjectProjection', 'effect-reservation'),
  ('deriveProjectProjection', 'effect-settlement');

INSERT INTO symbol_performs_effect(symbol_id, effect_id) VALUES
  ('performGitHubCommitStatusEffect', 'github-commit-status/create'),
  ('performGitHubPullRequestUpdateBranchEffect', 'github-pull-request/update-branch'),
  ('performKubernetesConfigMapEffect', 'kubernetes-configmap/ensure'),
  ('performPreparedSourceIntegration', 'source/integrate');

INSERT INTO symbol_dispatches_to_symbol(symbol_id, implementation_symbol_id) VALUES
  ('DurableFactStore.head', 'SqliteFactStore.head'),
  ('DurableFactStore.append', 'SqliteFactStore.append'),
  ('DurableFactStore.history', 'SqliteFactStore.history');

INSERT INTO artifact_witnesses_evidence(artifact_id, evidence_id) VALUES
  ('test/digest-pure.test.ts', 'canonical-content-identity-proof'),
  ('test/projection-reconstruction.test.ts', 'projection-reconstruction-proof'),
  ('test/projector-pure.test.ts', 'projection-reconstruction-proof'),
  ('test/provider-observation.test.ts', 'provider-observation-proof'),
  ('test/github-comment-attestation.test.ts', 'judgment-attestation-proof'),
  ('test/trusted-effect-core-loop.test.ts', 'effect-core-loop-proof');

INSERT INTO capability(capability_id) VALUES
  ('github-actions/permission/contents/write'),
  ('github-actions/permission/pull-requests/write'),
  ('github-actions/permission/statuses/write');

INSERT OR IGNORE INTO effect(effect_id) VALUES
  ('github-git-blob/create'),
  ('github-git-commit/create'),
  ('github-git-ref/create'),
  ('github-git-ref/delete'),
  ('github-git-ref/update'),
  ('github-git-tree/create'),
  ('github-pull-request/create'),
  ('github-source/integrate-verified-tree/v1');

INSERT INTO principal(principal_id) VALUES
  ('.github/workflows/codex-closed-loop.yml#publish'),
  ('.github/workflows/disposable-agent-proof.yml#agent-b'),
  ('.github/workflows/disposable-agent-proof.yml#effect-broker'),
  ('.github/workflows/disposable-agent-proof.yml#project-authority'),
  ('.github/workflows/distributed-authority-chaos.yml#cleanup'),
  ('.github/workflows/distributed-authority-chaos.yml#setup'),
  ('.github/workflows/distributed-authority-chaos.yml#sweep'),
  ('.github/workflows/distributed-authority-chaos.yml#verify'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-one'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-three'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-two'),
  ('.github/workflows/distributed-authority-handoff.yml#cleanup'),
  ('.github/workflows/distributed-authority-handoff.yml#controls'),
  ('.github/workflows/distributed-authority-handoff.yml#race'),
  ('.github/workflows/distributed-authority-handoff.yml#recover'),
  ('.github/workflows/distributed-authority-handoff.yml#reserve-effect'),
  ('.github/workflows/distributed-authority-handoff.yml#setup'),
  ('.github/workflows/github-object-transport-proof.yml#publish'),
  ('.github/workflows/operator-project-advance.yml#command'),
  ('.github/workflows/operator-project-submit.yml#command'),
  ('.github/workflows/production-criticality-mutation-probe.yml#graph-obligation'),
  ('.github/workflows/production-latency.yml#github-status-latency'),
  ('.github/workflows/promote-criticality-mutation-evidence.yml#promote'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-ambient-status-write'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-status-write-denied'),
  ('.github/workflows/substrate-capability-admission.yml#foreign-status-write-denied');

INSERT INTO principal_defined_in_artifact(principal_id, artifact_id) VALUES
  ('.github/workflows/codex-closed-loop.yml#publish', '.github/workflows/codex-closed-loop.yml'),
  ('.github/workflows/disposable-agent-proof.yml#agent-b', '.github/workflows/disposable-agent-proof.yml'),
  ('.github/workflows/disposable-agent-proof.yml#effect-broker', '.github/workflows/disposable-agent-proof.yml'),
  ('.github/workflows/disposable-agent-proof.yml#project-authority', '.github/workflows/disposable-agent-proof.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#cleanup', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#setup', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#sweep', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#verify', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-one', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-three', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-two', '.github/workflows/distributed-authority-chaos.yml'),
  ('.github/workflows/distributed-authority-handoff.yml#cleanup', '.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/distributed-authority-handoff.yml#controls', '.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/distributed-authority-handoff.yml#race', '.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/distributed-authority-handoff.yml#recover', '.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/distributed-authority-handoff.yml#reserve-effect', '.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/distributed-authority-handoff.yml#setup', '.github/workflows/distributed-authority-handoff.yml'),
  ('.github/workflows/github-object-transport-proof.yml#publish', '.github/workflows/github-object-transport-proof.yml'),
  ('.github/workflows/operator-project-advance.yml#command', '.github/workflows/operator-project-advance.yml'),
  ('.github/workflows/operator-project-submit.yml#command', '.github/workflows/operator-project-submit.yml'),
  ('.github/workflows/production-criticality-mutation-probe.yml#graph-obligation', '.github/workflows/production-criticality-mutation-probe.yml'),
  ('.github/workflows/production-latency.yml#github-status-latency', '.github/workflows/production-latency.yml'),
  ('.github/workflows/promote-criticality-mutation-evidence.yml#promote', '.github/workflows/promote-criticality-mutation-evidence.yml'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-ambient-status-write', '.github/workflows/substrate-capability-admission-treatment.yml'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-status-write-denied', '.github/workflows/substrate-capability-admission-treatment.yml'),
  ('.github/workflows/substrate-capability-admission.yml#foreign-status-write-denied', '.github/workflows/substrate-capability-admission.yml');

INSERT INTO principal_has_capability(principal_id, capability_id) VALUES
  ('.github/workflows/codex-closed-loop.yml#publish', 'github-actions/permission/contents/write'),
  ('.github/workflows/codex-closed-loop.yml#publish', 'github-actions/permission/pull-requests/write'),
  ('.github/workflows/disposable-agent-proof.yml#agent-b', 'github-actions/permission/contents/write'),
  ('.github/workflows/disposable-agent-proof.yml#effect-broker', 'github-actions/permission/contents/write'),
  ('.github/workflows/disposable-agent-proof.yml#effect-broker', 'github-actions/permission/statuses/write'),
  ('.github/workflows/disposable-agent-proof.yml#project-authority', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#cleanup', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#setup', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#sweep', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#verify', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-one', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-three', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-chaos.yml#wave-two', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#cleanup', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#cleanup', 'github-actions/permission/statuses/write'),
  ('.github/workflows/distributed-authority-handoff.yml#controls', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#controls', 'github-actions/permission/statuses/write'),
  ('.github/workflows/distributed-authority-handoff.yml#race', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#race', 'github-actions/permission/statuses/write'),
  ('.github/workflows/distributed-authority-handoff.yml#recover', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#recover', 'github-actions/permission/statuses/write'),
  ('.github/workflows/distributed-authority-handoff.yml#reserve-effect', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#reserve-effect', 'github-actions/permission/statuses/write'),
  ('.github/workflows/distributed-authority-handoff.yml#setup', 'github-actions/permission/contents/write'),
  ('.github/workflows/distributed-authority-handoff.yml#setup', 'github-actions/permission/statuses/write'),
  ('.github/workflows/github-object-transport-proof.yml#publish', 'github-actions/permission/contents/write'),
  ('.github/workflows/operator-project-advance.yml#command', 'github-actions/permission/contents/write'),
  ('.github/workflows/operator-project-submit.yml#command', 'github-actions/permission/contents/write'),
  ('.github/workflows/production-criticality-mutation-probe.yml#graph-obligation', 'github-actions/permission/contents/write'),
  ('.github/workflows/production-latency.yml#github-status-latency', 'github-actions/permission/statuses/write'),
  ('.github/workflows/promote-criticality-mutation-evidence.yml#promote', 'github-actions/permission/contents/write'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-ambient-status-write', 'github-actions/permission/statuses/write');

INSERT INTO principal_invokes_effect(principal_id, effect_id) VALUES
  ('.github/workflows/codex-closed-loop.yml#publish', 'github-git-ref/update'),
  ('.github/workflows/codex-closed-loop.yml#publish', 'github-pull-request/create'),
  ('.github/workflows/distributed-authority-chaos.yml#cleanup', 'github-git-ref/delete'),
  ('.github/workflows/distributed-authority-handoff.yml#cleanup', 'github-git-ref/delete'),
  ('.github/workflows/github-object-transport-proof.yml#publish', 'github-git-blob/create'),
  ('.github/workflows/github-object-transport-proof.yml#publish', 'github-git-commit/create'),
  ('.github/workflows/github-object-transport-proof.yml#publish', 'github-git-ref/create'),
  ('.github/workflows/github-object-transport-proof.yml#publish', 'github-git-tree/create'),
  ('.github/workflows/promote-criticality-mutation-evidence.yml#promote', 'github-git-ref/update'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-ambient-status-write', 'github-commit-status/create'),
  ('.github/workflows/substrate-capability-admission-treatment.yml#foreign-status-write-denied', 'github-commit-status/create'),
  ('.github/workflows/substrate-capability-admission.yml#foreign-status-write-denied', 'github-commit-status/create');

INSERT INTO principal_reaches_effect(principal_id, effect_id) VALUES
  ('.github/workflows/operator-project-submit.yml#command', 'github-source/integrate-verified-tree/v1');

INSERT INTO principal_holds_authority(principal_id, authority_id) VALUES
  ('.github/workflows/disposable-agent-proof.yml#agent-b', 'execution-authority'),
  ('.github/workflows/disposable-agent-proof.yml#effect-broker', 'effect-authority'),
  ('.github/workflows/disposable-agent-proof.yml#project-authority', 'project-authority');
