CREATE TABLE execution_state (
  subject_key text PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('project_transition', 'legacy_work')),
  project_ref text,
  transition_id text,
  authority_epoch bigint NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  lease_ref text UNIQUE,
  run_id text REFERENCES orchestration_runs(run_id),
  authority_repository text,
  authority_revision text,
  graph_fingerprint text,
  transition_revision_fingerprint text,
  transition_dependency_fingerprint text,
  expires_at timestamptz,
  hard_expires_at timestamptz,
  active_capability_material text,
  checkpoint jsonb,
  checkpoint_sha256 text,
  recent_progress_sha256 jsonb NOT NULL DEFAULT '[]'::jsonb,
  heartbeat_count integer NOT NULL DEFAULT 0 CHECK (heartbeat_count >= 0),
  last_heartbeat_at timestamptz,
  continuation jsonb,
  continuation_sha256 text,
  continuation_execution_fingerprint text,
  no_progress_streak integer NOT NULL DEFAULT 0 CHECK (no_progress_streak >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(recent_progress_sha256) = 'array'),
  CHECK (jsonb_array_length(recent_progress_sha256) <= 2),
  CHECK (
    lease_ref IS NULL OR (
      run_id IS NOT NULL
      AND authority_repository IS NOT NULL
      AND authority_revision IS NOT NULL
      AND expires_at IS NOT NULL
      AND hard_expires_at IS NOT NULL
    )
  ),
  CHECK (
    subject_kind <> 'project_transition' OR (
      project_ref IS NOT NULL
      AND transition_id IS NOT NULL
    )
  )
);

CREATE INDEX execution_state_run_idx ON execution_state (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX execution_state_active_expiry_idx ON execution_state (expires_at) WHERE lease_ref IS NOT NULL;
