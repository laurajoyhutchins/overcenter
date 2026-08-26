CREATE TABLE IF NOT EXISTS github_required_check_observations (
  repo text NOT NULL,
  pull_request integer NOT NULL CHECK (pull_request > 0),
  head_sha char(40) NOT NULL,
  required_context text NOT NULL,
  first_missing_at timestamptz NOT NULL,
  last_missing_at timestamptz NOT NULL,
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  PRIMARY KEY (repo, pull_request, head_sha, required_context)
)
