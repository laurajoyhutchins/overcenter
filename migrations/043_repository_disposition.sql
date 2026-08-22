CREATE TABLE IF NOT EXISTS portfolio_repository_disposition (
  repository text PRIMARY KEY,
  disposition text NOT NULL CHECK (disposition IN ('ACTIVE','MAINTENANCE','DORMANT','ARCHIVED','SUPERSEDED')),
  compatibility_bound boolean NOT NULL DEFAULT false,
  successor_repository text,
  github_archived boolean,
  github_observed_at timestamptz,
  transition_reason text,
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT compatibility_bound OR disposition IN ('ARCHIVED','SUPERSEDED')),
  CHECK (successor_repository IS NULL OR lower(successor_repository) <> lower(repository))
);