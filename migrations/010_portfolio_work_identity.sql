CREATE TABLE IF NOT EXISTS portfolio_work_identity (
  source_key text PRIMARY KEY,
  source_kind text NOT NULL,
  source_repo text NOT NULL,
  source_issue_number integer NOT NULL,
  linear_issue_id text NOT NULL,
  linear_identifier text NOT NULL,
  last_source_revision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)