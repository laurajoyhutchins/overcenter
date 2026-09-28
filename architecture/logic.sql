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
  ('effect-settlement'),
  ('source-integration');

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
  ('effect-settlement', 'effect-reservation'),
  ('effect-settlement', 'authoritative-observation'),
  ('effect-settlement', 'durable-project-facts'),
  ('source-integration', 'effect-authorization'),
  ('source-integration', 'effect-reservation'),
  ('source-integration', 'effect-settlement');
