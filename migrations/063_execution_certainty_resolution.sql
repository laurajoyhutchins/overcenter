BEGIN;

-- Mutation certainty is an epistemic state, not a one-way numeric rank:
-- an unknown effect may resolve either to confirmed mutation or to definite
-- absence. A confirmed mutation can never be rewritten as absent.
CREATE OR REPLACE FUNCTION overcenter_certainty_transition_allowed(old_value text, new_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN old_value = 'confirmed_mutated'
      THEN new_value = 'confirmed_mutated'
    WHEN old_value IN ('definitely_not_mutated', 'may_have_mutated')
      THEN new_value IN ('definitely_not_mutated', 'may_have_mutated', 'confirmed_mutated')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION overcenter_enforce_operation_certainty()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NOT overcenter_certainty_transition_allowed(
       OLD.mutation_certainty,
       NEW.mutation_certainty
     ) THEN
    RAISE EXCEPTION 'OPERATION_MUTATION_CERTAINTY_REGRESSION'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('no_effect', 'rejected')
     AND NEW.mutation_certainty <> 'definitely_not_mutated' THEN
    RAISE EXCEPTION 'OPERATION_UNCERTAIN_TERMINAL_STATE'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'succeeded'
     AND NEW.mutation_certainty = 'confirmed_mutated'
     AND NEW.effect_ref IS NULL THEN
    RAISE EXCEPTION 'OPERATION_CONFIRMED_EFFECT_MISSING_REFERENCE'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overcenter_operation_certainty_guard ON operation_state;
CREATE TRIGGER overcenter_operation_certainty_guard
BEFORE INSERT OR UPDATE ON operation_state
FOR EACH ROW
EXECUTE FUNCTION overcenter_enforce_operation_certainty();

COMMIT;
