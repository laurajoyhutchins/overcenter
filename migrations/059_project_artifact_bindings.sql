CREATE TABLE IF NOT EXISTS project_artifact_bindings (
  binding_id text PRIMARY KEY,
  project_ref text NOT NULL,
  transition_id text NOT NULL,
  authority_revision text NOT NULL,
  repository text NOT NULL,
  provider_kind text NOT NULL,
  provider_id bigint NOT NULL,
  relationship text NOT NULL,
  satisfaction_kind text NOT NULL,
  binding_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_artifact_bindings_subject_idx ON project_artifact_bindings(project_ref, transition_id, created_at);
CREATE INDEX IF NOT EXISTS project_artifact_bindings_provider_idx ON project_artifact_bindings(repository, provider_kind, provider_id, created_at);