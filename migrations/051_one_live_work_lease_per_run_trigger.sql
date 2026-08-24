CREATE TRIGGER work_leases_one_live_per_run
BEFORE INSERT OR UPDATE OF run_id,status,expires_at ON work_leases
FOR EACH ROW EXECUTE FUNCTION enforce_one_live_work_lease_per_run()