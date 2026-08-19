CREATE TABLE IF NOT EXISTS github_repository_creation_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_sha256 text NOT NULL,
  repo text NOT NULL,
  name text NOT NULL,
  description text,
  state text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  consumed_at timestamptz,
  decision_note text
)