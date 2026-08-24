CREATE FUNCTION enforce_one_live_work_lease_per_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('claiming','active','settling') AND NEW.expires_at > now() THEN
    PERFORM 1 FROM orchestration_runs WHERE run_id = NEW.run_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RUN_NOT_REGISTERED: live work lease requires an orchestration run';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM work_leases l
      WHERE l.run_id = NEW.run_id
        AND l.lease_id <> NEW.lease_id
        AND l.status IN ('claiming','active','settling')
        AND l.expires_at > now()
    )
    THEN
      RAISE EXCEPTION 'RUN_HAS_ACTIVE_LEASE: orchestration run already owns live work';
    END IF;
  END IF;
  RETURN NEW;
END;
$$