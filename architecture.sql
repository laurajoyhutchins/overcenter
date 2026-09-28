-- Canonical desired architecture for Overcenter Research.
--
-- This file declares intent only. Observed source, workflow, authority, and
-- effect facts are derived independently from an exact source revision and
-- reconciled against these relations. Nothing observed is written back here.
--
-- Keep this schema semantic. Repository paths below are physical bindings of
-- architectural concepts, not the architecture vocabulary itself.

PRAGMA foreign_keys = ON;

CREATE TABLE architecture_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (length(trim(schema)) > 0)
) STRICT;

CREATE TABLE architecture_claim (
  concept TEXT NOT NULL CHECK (length(trim(concept)) > 0),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'authority-role',
      'github-actions-explicit-write-authority',
      'github-actions-provider-effect-authority',
      'workflow-transitive-effect-authority'
    )
  ),
  PRIMARY KEY (concept, kind),
  UNIQUE (concept)
) STRICT;

CREATE TABLE authority_role (
  concept TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'authority-role' CHECK (kind = 'authority-role'),
  authority_path TEXT NOT NULL UNIQUE CHECK (length(trim(authority_path)) > 0),
  FOREIGN KEY (concept, kind)
    REFERENCES architecture_claim(concept, kind)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE authority_projection (
  concept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'authority-role' CHECK (kind = 'authority-role'),
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  PRIMARY KEY (concept, path),
  FOREIGN KEY (concept, kind)
    REFERENCES architecture_claim(concept, kind)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE authority_verifier (
  concept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'authority-role' CHECK (kind = 'authority-role'),
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  PRIMARY KEY (concept, path),
  FOREIGN KEY (concept, kind)
    REFERENCES architecture_claim(concept, kind)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE github_actions_explicit_write (
  concept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'github-actions-explicit-write-authority'
    CHECK (kind = 'github-actions-explicit-write-authority'),
  workflow TEXT NOT NULL CHECK (length(trim(workflow)) > 0),
  permission TEXT NOT NULL CHECK (length(trim(permission)) > 0),
  PRIMARY KEY (concept, workflow, permission),
  FOREIGN KEY (concept, kind)
    REFERENCES architecture_claim(concept, kind)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE github_actions_provider_effect (
  concept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'github-actions-provider-effect-authority'
    CHECK (kind = 'github-actions-provider-effect-authority'),
  workflow TEXT NOT NULL CHECK (length(trim(workflow)) > 0),
  effect TEXT NOT NULL CHECK (length(trim(effect)) > 0),
  PRIMARY KEY (concept, workflow, effect),
  FOREIGN KEY (concept, kind)
    REFERENCES architecture_claim(concept, kind)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE workflow_transitive_effect (
  concept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'workflow-transitive-effect-authority'
    CHECK (kind = 'workflow-transitive-effect-authority'),
  workflow TEXT NOT NULL CHECK (length(trim(workflow)) > 0),
  effect TEXT NOT NULL CHECK (length(trim(effect)) > 0),
  PRIMARY KEY (concept, workflow, effect),
  FOREIGN KEY (concept, kind)
    REFERENCES architecture_claim(concept, kind)
    ON DELETE CASCADE
) STRICT;

INSERT INTO architecture_metadata(singleton, schema)
VALUES (1, 'overcenter-architecture-intent/v1');

INSERT INTO architecture_claim(concept, kind) VALUES
  ('canonical-content-identity', 'authority-role'),
  ('durable-project-facts', 'authority-role'),
  ('effect-reservation-and-settlement', 'authority-role'),
  ('github-actions-direct-provider-effects', 'github-actions-provider-effect-authority'),
  ('github-actions-explicit-write-capability', 'github-actions-explicit-write-authority'),
  ('project-lifecycle-projection', 'authority-role'),
  ('provider-observation-semantics', 'authority-role'),
  ('workflow-transitive-provider-effects', 'workflow-transitive-effect-authority');

INSERT INTO authority_role(concept, authority_path) VALUES
  ('canonical-content-identity', 'src/digest.ts'),
  ('durable-project-facts', 'src/authority/facts.ts'),
  ('effect-reservation-and-settlement', 'src/authority/engine.ts'),
  ('project-lifecycle-projection', 'src/authority/project-state.ts'),
  ('provider-observation-semantics', 'src/observation/observe.ts');

INSERT INTO authority_projection(concept, path) VALUES
  ('durable-project-facts', 'src/authority/project-state.ts'),
  ('effect-reservation-and-settlement', 'src/authority/project-state.ts');

INSERT INTO authority_verifier(concept, path) VALUES
  ('canonical-content-identity', 'test/digest-pure.test.ts'),
  ('durable-project-facts', 'src/authority/replay.ts'),
  ('effect-reservation-and-settlement', 'test/trusted-effect-core-loop.test.ts'),
  ('project-lifecycle-projection', 'test/projector-pure.test.ts'),
  ('project-lifecycle-projection', 'test/projection-reconstruction.test.ts'),
  ('provider-observation-semantics', 'test/provider-observation.test.ts');

INSERT INTO github_actions_explicit_write(concept, workflow, permission) VALUES
  ('github-actions-explicit-write-capability', '.github/workflows/codex-closed-loop.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/codex-closed-loop.yml', 'pull-requests'),
  ('github-actions-explicit-write-capability', '.github/workflows/disposable-agent-proof.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/disposable-agent-proof.yml', 'statuses'),
  ('github-actions-explicit-write-capability', '.github/workflows/distributed-authority-chaos.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/distributed-authority-handoff.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/distributed-authority-handoff.yml', 'statuses'),
  ('github-actions-explicit-write-capability', '.github/workflows/github-object-transport-proof.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/operator-project-advance.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/operator-project-submit.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/production-criticality-mutation-probe.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/production-latency.yml', 'statuses'),
  ('github-actions-explicit-write-capability', '.github/workflows/promote-criticality-mutation-evidence.yml', 'contents'),
  ('github-actions-explicit-write-capability', '.github/workflows/substrate-capability-admission-treatment.yml', 'statuses');

INSERT INTO github_actions_provider_effect(concept, workflow, effect) VALUES
  ('github-actions-direct-provider-effects', '.github/workflows/codex-closed-loop.yml', 'github-git-ref/update'),
  ('github-actions-direct-provider-effects', '.github/workflows/codex-closed-loop.yml', 'github-pull-request/create'),
  ('github-actions-direct-provider-effects', '.github/workflows/distributed-authority-chaos.yml', 'github-git-ref/delete'),
  ('github-actions-direct-provider-effects', '.github/workflows/distributed-authority-handoff.yml', 'github-git-ref/delete'),
  ('github-actions-direct-provider-effects', '.github/workflows/github-object-transport-proof.yml', 'github-git-blob/create'),
  ('github-actions-direct-provider-effects', '.github/workflows/github-object-transport-proof.yml', 'github-git-commit/create'),
  ('github-actions-direct-provider-effects', '.github/workflows/github-object-transport-proof.yml', 'github-git-ref/create'),
  ('github-actions-direct-provider-effects', '.github/workflows/github-object-transport-proof.yml', 'github-git-tree/create'),
  ('github-actions-direct-provider-effects', '.github/workflows/promote-criticality-mutation-evidence.yml', 'github-git-ref/update'),
  ('github-actions-direct-provider-effects', '.github/workflows/substrate-capability-admission-treatment.yml', 'github-commit-status/create'),
  ('github-actions-direct-provider-effects', '.github/workflows/substrate-capability-admission.yml', 'github-commit-status/create');

INSERT INTO workflow_transitive_effect(concept, workflow, effect) VALUES
  ('workflow-transitive-provider-effects', '.github/workflows/operator-project-advance.yml', 'github-source/integrate-verified-tree/v1'),
  ('workflow-transitive-provider-effects', '.github/workflows/operator-project-submit.yml', 'github-source/integrate-verified-tree/v1'),
  ('workflow-transitive-provider-effects', '.github/workflows/production-criticality-mutation-probe.yml', 'github-source/integrate-verified-tree/v1'),
  ('workflow-transitive-provider-effects', '.github/workflows/promote-criticality-mutation-evidence.yml', 'github-source/integrate-verified-tree/v1');
