CREATE TABLE orchestration_invocation_resolutions (
  resolution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id uuid NOT NULL,
  resolution_kind text NOT NULL CHECK (resolution_kind IN ('externally_confirmed','definitively_not_applied','superseded','abandoned')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)