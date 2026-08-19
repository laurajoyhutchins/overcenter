CREATE TABLE IF NOT EXISTS github_user_authorizations (
  capability text PRIMARY KEY,
  app_client_id text,
  github_login text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_ciphertext text,
  refresh_token_expires_at timestamptz,
  pending_device_code_ciphertext text,
  pending_user_code text,
  pending_verification_uri text,
  pending_expires_at timestamptz,
  pending_interval_seconds integer,
  authorized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
)