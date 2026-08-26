export const requiredCheckObservationPolicy = Object.freeze({
  minimum_observations: 3,
  minimum_age_ms: 15000,
});

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('observed_at must be a valid timestamp');
  return date.toISOString();
}

function ageMs(first, observed) {
  const firstMs = Date.parse(first);
  const observedMs = Date.parse(observed);
  return Number.isFinite(firstMs) && Number.isFinite(observedMs) ? Math.max(0, observedMs - firstMs) : 0;
}

export async function stabilizeRequiredCheckEvaluation(evaluation, context = {}) {
  const store = context.store || null;
  if (!store || evaluation?.required_set_complete !== true) return evaluation;

  const observedAt = asIso(context.observed_at || new Date());
  const observedRequired = [
    ...(evaluation.passing_required || []),
    ...(evaluation.pending_required || []),
    ...(evaluation.failing_required || []),
  ];
  if (observedRequired.length && typeof store.clearObserved === 'function') {
    await store.clearObserved({
      repo: context.repo,
      pull_request: context.pull_request,
      head_sha: context.head_sha,
      required_contexts: observedRequired,
    });
  }

  const rawMissing = [...(evaluation.missing_required || [])];
  if (rawMissing.length === 0) {
    return {
      ...evaluation,
      awaiting_observation_required: [],
      required_observation_state: 'OBSERVED',
      required_observation_count: 0,
      required_observation_age_ms: 0,
    };
  }

  const mature = [];
  const awaiting = [];
  let maximumCount = 0;
  let maximumAge = 0;
  for (const requiredContext of rawMissing) {
    const row = await store.observeMissing({
      repo: context.repo,
      pull_request: context.pull_request,
      head_sha: context.head_sha,
      required_context: requiredContext,
      observed_at: observedAt,
    });
    const count = Number(row?.observation_count || 0);
    const age = ageMs(row?.first_missing_at, observedAt);
    maximumCount = Math.max(maximumCount, count);
    maximumAge = Math.max(maximumAge, age);
    if (count >= requiredCheckObservationPolicy.minimum_observations
        && age >= requiredCheckObservationPolicy.minimum_age_ms) mature.push(requiredContext);
    else awaiting.push(requiredContext);
  }

  const knownFailure = (evaluation.pending_required || []).length > 0
    || (evaluation.failing_required || []).length > 0
    || mature.length > 0;
  return {
    ...evaluation,
    missing_required: mature,
    awaiting_observation_required: awaiting,
    required_observation_state: mature.length ? 'CHECK_DELIVERY_MISSING' : 'AWAITING_CHECK_OBSERVATION',
    required_observation_count: maximumCount,
    required_observation_age_ms: maximumAge,
    required_satisfied: knownFailure ? false : (awaiting.length ? null : evaluation.required_satisfied),
  };
}

export function createPostgresRequiredCheckObservationStore(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('db.query is required');
  return {
    async observeMissing(input) {
      const observedAt = asIso(input.observed_at);
      const sql = 'INSERT INTO github_required_check_observations (repo, pull_request, head_sha, required_context, first_missing_at, last_missing_at, observation_count) ' +
        'VALUES ($1,$2,$3,$4,$5,$5,1) ' +
        'ON CONFLICT (repo, pull_request, head_sha, required_context) DO UPDATE SET last_missing_at = EXCLUDED.last_missing_at, observation_count = github_required_check_observations.observation_count + 1 ' +
        'RETURNING first_missing_at, last_missing_at, observation_count';
      const result = await dbBinding.query(sql, [input.repo, input.pull_request, input.head_sha, input.required_context, observedAt]);
      const row = result.rows[0] || null;
      return row ? {
        first_missing_at: asIso(row.first_missing_at),
        last_missing_at: asIso(row.last_missing_at),
        observation_count: Number(row.observation_count || 0),
      } : null;
    },
    async clearObserved(input) {
      for (const requiredContext of input.required_contexts || []) {
        await dbBinding.query(
          'DELETE FROM github_required_check_observations WHERE repo = $1 AND pull_request = $2 AND head_sha = $3 AND required_context = $4',
          [input.repo, input.pull_request, input.head_sha, requiredContext],
        );
      }
    },
  };
}
