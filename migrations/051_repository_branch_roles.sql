CREATE TABLE IF NOT EXISTS portfolio_repository_branch_roles (
  repository text PRIMARY KEY,
  development_branch text NOT NULL,
  production_branch text NOT NULL,
  production_source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (development_branch = 'dev'),
  CHECK (development_branch <> production_branch)
)
