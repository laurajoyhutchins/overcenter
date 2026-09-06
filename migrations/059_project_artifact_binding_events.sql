CREATE TABLE IF NOT EXISTS project_artifact_binding_events (
  binding_sha256 text PRIMARY KEY CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
  project_ref text NOT NULL,
  transition_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('bind','rebind','revoke')),
  authority_repository text NOT NULL,
  authority_revision text NOT NULL CHECK (authority_revision ~ '^[0-9a-f]{40}$'),
  artifact_provider text NOT NULL CHECK (artifact_provider = 'github'),
  artifact_repository text NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('issue','pull_request')),
  artifact_number integer NOT NULL CHECK (artifact_number > 0),
  artifact_node_id text NOT NULL,
  artifact_state text NOT NULL CHECK (artifact_state IN ('open','closed')),
  relationship text NOT NULL,
  satisfaction_condition text NOT NULL,
  prior_binding_sha256 text NULL CHECK (prior_binding_sha256 IS NULL OR prior_binding_sha256 ~ '^[0-9a-f]{64}$'),
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_artifact_binding_events_subject_idx
  ON project_artifact_binding_events (project_ref, transition_id, created_at DESC);
