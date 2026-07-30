import { canonicalJson, sha256Text } from './canonical-json.js';
import { reduceEntity } from './reducer.js';
import { createPostgresRepository } from './store.js';

const REQUIRED_TABLES = [
  'portfolio_observations',
  'portfolio_entity_projections',
  'portfolio_reconciliation_runs',
];

export async function runDiagnostics(db) {
  const checks = [];
  for (const table of REQUIRED_TABLES) {
    const result = await db.query(
      'SELECT table_name FROM information_schema.tables WHERE table_name = $1',
      [table]
    );
    checks.push({ check: `table:${table}`, ok: result.rows[0]?.table_name === table });
  }

  const observationRows = await db.query(
    `SELECT idempotency_key,payload,payload_canonical,payload_sha256
       FROM portfolio_observations ORDER BY created_at DESC LIMIT 200`
  );
  let observationDigestsOk = true;
  for (const row of observationRows.rows) {
    const canonical = canonicalJson(row.payload);
    const digest = await sha256Text(canonical);
    if (canonical !== row.payload_canonical || digest !== row.payload_sha256) {
      observationDigestsOk = false;
      break;
    }
  }
  checks.push({ check: 'observation_digests', ok: observationDigestsOk, sampled: observationRows.rows.length });

  const projectionRows = await db.query(
    `SELECT entity_key,projection,projection_sha256
       FROM portfolio_entity_projections ORDER BY updated_at DESC LIMIT 100`
  );
  let projectionDigestsOk = true;
  for (const row of projectionRows.rows) {
    const digestable = { ...row.projection, projection_sha256: null };
    const digest = await sha256Text(canonicalJson(digestable));
    if (digest !== row.projection_sha256 || row.projection.projection_sha256 !== row.projection_sha256) {
      projectionDigestsOk = false;
      break;
    }
  }
  checks.push({ check: 'projection_digests', ok: projectionDigestsOk, sampled: projectionRows.rows.length });

  const duplicateRows = await db.query(
    `SELECT count(*)::integer AS count FROM (
       SELECT idempotency_key FROM portfolio_observations
       GROUP BY idempotency_key HAVING count(*) > 1
     ) duplicates`
  );
  checks.push({ check: 'duplicate_idempotency_keys', ok: (duplicateRows.rows[0]?.count || 0) === 0 });

  const repository = createPostgresRepository(db);
  const sampleKeys = projectionRows.rows.slice(0, 10).map((row) => row.entity_key);
  let deterministicSampleOk = true;
  if (sampleKeys.length) {
    const observations = await repository.listObservationsForEntities(sampleKeys);
    const grouped = new Map(sampleKeys.map((key) => [key, []]));
    for (const row of observations) grouped.get(row.entity_key)?.push(row);
    const expectedByKey = new Map(projectionRows.rows.map((row) => [row.entity_key, row.projection_sha256]));
    for (const key of sampleKeys) {
      const rebuilt = await reduceEntity(key, grouped.get(key) || []);
      if (rebuilt.projection_sha256 !== expectedByKey.get(key)) {
        deterministicSampleOk = false;
        break;
      }
    }
  }
  checks.push({ check: 'deterministic_sample_rebuild', ok: deterministicSampleOk, sampled: sampleKeys.length });

  const failedRuns = await db.query(
    `SELECT count(*)::integer AS count FROM portfolio_reconciliation_runs
      WHERE outcome='failed' AND started_at > now() - interval '24 hours'`
  );
  checks.push({ check: 'recent_failed_runs', ok: (failedRuns.rows[0]?.count || 0) === 0, count: failedRuns.rows[0]?.count || 0 });

  return {
    schema: 'portfolio-reconciler-diagnostics-v1',
    mode: 'shadow',
    ok: checks.every((check) => check.ok),
    checks,
    observed_at: new Date().toISOString(),
  };
}