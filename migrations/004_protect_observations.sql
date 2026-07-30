CREATE FUNCTION reject_portfolio_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'portfolio observations are append-only';
END;
$$