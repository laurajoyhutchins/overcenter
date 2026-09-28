-- Desired Overcenter architecture.
--
-- This file declares what must remain true regardless of implementation.
-- It contains no source paths, symbols, workflow paths, or execution principals.

INSERT INTO authority(authority_id) VALUES
  ('project-authority'),
  ('execution-authority'),
  ('effect-authority');

INSERT INTO effect(effect_id) VALUES
  ('github-commit-status/create'),
  ('github-pull-request/update-branch'),
  ('kubernetes-configmap/ensure'),
  ('source/integrate');

INSERT INTO obligation(obligation_id) VALUES
  ('exact-revision-effect'),
  ('reserve-before-effect'),
  ('authoritative-settlement'),
  ('unresolved-effect-no-replay');

INSERT INTO evidence(evidence_id) VALUES
  ('canonical-content-identity-proof'),
  ('projection-reconstruction-proof'),
  ('provider-observation-proof'),
  ('effect-core-loop-proof');

INSERT INTO capability(capability_id) VALUES
  ('canonical-content-identity'),
  ('durable-project-facts'),
  ('project-lifecycle-projection'),
  ('authoritative-observation'),
  ('effect-authorization'),
  ('effect-reservation'),
  ('effect-execution'),
  ('effect-release'),
  ('effect-settlement'),
  ('source-integration'),
  ('github-commit-status-mutation'),
  ('github-commit-status-observation');

INSERT INTO assurance_property(property_id) VALUES
  ('broker-mutation-safety'),
  ('no-false-done'),
  ('github-commit-status-provider');

INSERT INTO assurance_property_requires_authority(property_id, authority_id) VALUES
  ('broker-mutation-safety', 'effect-authority');

INSERT INTO assurance_property_requires_capability(property_id, capability_id) VALUES
  ('broker-mutation-safety', 'effect-authorization'),
  ('broker-mutation-safety', 'effect-reservation'),
  ('broker-mutation-safety', 'effect-execution'),
  ('broker-mutation-safety', 'effect-release'),
  ('no-false-done', 'durable-project-facts'),
  ('no-false-done', 'project-lifecycle-projection'),
  ('no-false-done', 'authoritative-observation'),
  ('no-false-done', 'effect-settlement'),
  ('github-commit-status-provider', 'github-commit-status-mutation'),
  ('github-commit-status-provider', 'github-commit-status-observation');

INSERT INTO assurance_property_guards_effect(property_id, effect_id) VALUES
  ('broker-mutation-safety', 'github-commit-status/create'),
  ('broker-mutation-safety', 'github-pull-request/update-branch'),
  ('broker-mutation-safety', 'kubernetes-configmap/ensure'),
  ('broker-mutation-safety', 'source/integrate'),
  ('no-false-done', 'github-commit-status/create'),
  ('no-false-done', 'github-pull-request/update-branch'),
  ('no-false-done', 'kubernetes-configmap/ensure'),
  ('no-false-done', 'source/integrate'),
  ('github-commit-status-provider', 'github-commit-status/create');

INSERT INTO assurance_property_requires_effect_implementation(property_id, effect_id) VALUES
  ('github-commit-status-provider', 'github-commit-status/create');

INSERT INTO assurance_property_composes_with(property_id, required_property_id) VALUES
  ('github-commit-status-provider', 'broker-mutation-safety');

INSERT INTO effect_requires_authority(effect_id, authority_id) VALUES
  ('github-commit-status/create', 'effect-authority'),
  ('github-pull-request/update-branch', 'effect-authority'),
  ('kubernetes-configmap/ensure', 'effect-authority'),
  ('source/integrate', 'effect-authority');

INSERT INTO authority_depends_on_authority(authority_id, required_authority_id) VALUES
  ('execution-authority', 'project-authority'),
  ('effect-authority', 'execution-authority');

INSERT INTO effect_requires_capability(effect_id, capability_id)
SELECT effect_id, capability_id
FROM effect
CROSS JOIN (
  SELECT 'effect-authorization' AS capability_id
  UNION ALL SELECT 'effect-reservation'
  UNION ALL SELECT 'effect-execution'
  UNION ALL SELECT 'effect-release'
  UNION ALL SELECT 'effect-settlement'
);

INSERT INTO effect_requires_capability(effect_id, capability_id) VALUES
  ('source/integrate', 'source-integration');

INSERT INTO obligation_guards_effect(obligation_id, effect_id)
SELECT obligation_id, effect_id
FROM obligation
CROSS JOIN effect;

INSERT INTO evidence_witnesses_obligation(evidence_id, obligation_id) VALUES
  ('effect-core-loop-proof', 'exact-revision-effect'),
  ('effect-core-loop-proof', 'reserve-before-effect'),
  ('provider-observation-proof', 'authoritative-settlement'),
  ('effect-core-loop-proof', 'unresolved-effect-no-replay');

INSERT INTO evidence_witnesses_capability(evidence_id, capability_id) VALUES
  ('canonical-content-identity-proof', 'canonical-content-identity'),
  ('projection-reconstruction-proof', 'durable-project-facts'),
  ('projection-reconstruction-proof', 'project-lifecycle-projection'),
  ('provider-observation-proof', 'authoritative-observation'),
  ('effect-core-loop-proof', 'effect-authorization'),
  ('effect-core-loop-proof', 'effect-reservation'),
  ('effect-core-loop-proof', 'effect-settlement');

INSERT INTO capability_depends_on_capability(capability_id, required_capability_id) VALUES
  ('project-lifecycle-projection', 'durable-project-facts'),
  ('effect-authorization', 'canonical-content-identity'),
  ('effect-authorization', 'durable-project-facts'),
  ('effect-reservation', 'effect-authorization'),
  ('effect-reservation', 'durable-project-facts'),
  ('effect-execution', 'effect-reservation'),
  ('effect-release', 'effect-reservation'),
  ('effect-settlement', 'effect-execution'),
  ('effect-settlement', 'effect-reservation'),
  ('effect-settlement', 'authoritative-observation'),
  ('effect-settlement', 'durable-project-facts'),
  ('source-integration', 'effect-authorization'),
  ('source-integration', 'effect-reservation'),
  ('source-integration', 'effect-settlement');
