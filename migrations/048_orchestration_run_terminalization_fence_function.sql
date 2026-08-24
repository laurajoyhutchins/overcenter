CREATE FUNCTION enforce_orchestration_run_terminalization_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'finished'
     AND OLD.status IS DISTINCT FROM 'finished'
     AND EXISTS (
       SELECT 1
       FROM work_leases l
       WHERE l.run_id = NEW.run_id
         AND l.status IN ('claiming','active','settling')
         AND l.expires_at > now()
     )
  THEN
    RAISE EXCEPTION 'RUN_HAS_ACTIVE_LEASE: orchestration run cannot finish while live work ownership remains';
  END IF;
  RETURN NEW;
END;
$$