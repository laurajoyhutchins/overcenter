import { canonicalJson, sha256Text } from './canonical-json.js';
import { reduceEntity } from './reducer.js';

const IDENTIFIER = /^[a-z][a-z0-9_.-]{0,127}$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BATCH = 200;
const MAX_RECONCILE = 1000;

function codedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requireString(value, name, { max = 512, pattern = null } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || (pattern && !pattern.test(text))) {
    throw codedError('OBSERVATION_INVALID', `${name} is invalid`, { field: name });
  }
  return text;
}

function validIso(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function immutableSignature(row) {
  return canonicalJson({
    idempotency_key: row.idempotency_key,
    source_system: row.source_system,
    entity_type: row.entity_type,
    entity_key: row.entity_key,
    fact_type: row.fact_type,
    observed_at: row.observed_at,
    source_revision: row.source_revision,
    payload_canonical: row.payload_canonical,
    payload_sha256: row.payload_sha256,
  });
}

export async function normalizeObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw codedError('OBSERVATION_INVALID', 'observation must be an object');
  }
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('OBSERVATION_INVALID', 'payload must be an object', { field: 'payload' });
  }
  const observedAt = String(input.observed_at || '');
  if (!validIso(observedAt)) {
    throw codedError('OBSERVATION_INVALID', 'observed_at must be a canonical ISO timestamp', { field: 'observed_at' });
  }
  const payloadCanonical = canonicalJson(payload);
  const payloadSha256 = await sha256Text(payloadCanonical);
  return {
    idempotency_key: requireString(input.idempotency_key, 'idempotency_key', { max: 512 }),
    source_system: requireString(input.source_system, 'source_system', { max: 64, pattern: SOURCE }),
    entity_type: requireString(input.entity_type, 'entity_type', { max: 64, pattern: IDENTIFIER }),
    entity_key: requireString(input.entity_key, 'entity_key', { max: 512 }),
    fact_type: requireString(input.fact_type, 'fact_type', { max: 128, pattern: IDENTIFIER }),
    observed_at: observedAt,
    source_revision: requireString(input.source_revision, 'source_revision', { max: 512 }),
    payload: JSON.parse(payloadCanonical),
    payload_canonical: payloadCanonical,
    payload_sha256: payloadSha256,
  };
}

async function normalizeBatch(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_BATCH) {
    throw codedError('OBSERVATION_BATCH_INVALID', `observations must contain 1-${MAX_BATCH} entries`);
  }
  const rows = await Promise.all(inputs.map(normalizeObservation));
  const seen = new Map();
  for (const row of rows) {
    const prior = seen.get(row.idempotency_key);
    if (prior && immutableSignature(prior) !== immutableSignature(row)) {
      throw codedError('OBSERVATION_IDEMPOTENCY_CONFLICT', 'batch reuses an idempotency key with different content', {
        idempotency_key: row.idempotency_key,
      });
    }
    seen.set(row.idempotency_key, row);
  }
  return [...seen.values()];
}

export function createPortfolioService(repository) {
  if (!repository) throw new TypeError('repository is required');

  async function reconcileEntities({ entityKeys = null, mode = 'shadow', limit = 500 } = {}) {
    if (mode !== 'shadow') throw codedError('RECONCILE_MODE_INVALID', 'only shadow mode is supported');
    const boundedLimit = Math.min(Math.max(Number(limit) || 500, 1), MAX_RECONCILE);
    const keys = Array.isArray(entityKeys)
      ? [...new Set(entityKeys.map((key) => requireString(key, 'entity_key', { max: 512 })))].sort().slice(0, boundedLimit)
      : await repository.listEntityKeys(boundedLimit);
    const runId = await repository.beginRun({ mode, entityKeys: keys });
    try {
      if (!keys.length) {
        const outputDigest = await sha256Text('[]');
        await repository.commitRun(runId, [], {
          input_watermark: null,
          source_observation_count: 0,
          affected_entity_count: 0,
          projection_count: 0,
          discrepancy_count: 0,
          output_digest: outputDigest,
        });
        return { run_id: runId, mode, entity_keys: [], projection_count: 0, discrepancy_count: 0, output_digest: outputDigest };
      }
      const observations = await repository.listObservationsForEntities(keys);
      const grouped = new Map(keys.map((key) => [key, []]));
      for (const observation of observations) {
        if (grouped.has(observation.entity_key)) grouped.get(observation.entity_key).push(observation);
      }
      const projections = [];
      for (const key of keys) projections.push(await reduceEntity(key, grouped.get(key) || []));
      const digestInput = projections
        .map((projection) => [projection.entity_key, projection.projection_sha256])
        .sort(([a], [b]) => a.localeCompare(b));
      const outputDigest = await sha256Text(canonicalJson(digestInput));
      const discrepancyCount = projections.reduce((sum, projection) => sum + projection.discrepancies.length, 0);
      const inputWatermark = observations.map((item) => item.observed_at).sort().at(-1) || null;
      await repository.commitRun(runId, projections, {
        input_watermark: inputWatermark,
        source_observation_count: observations.length,
        affected_entity_count: keys.length,
        projection_count: projections.length,
        discrepancy_count: discrepancyCount,
        output_digest: outputDigest,
      });
      return {
        run_id: runId,
        mode,
        entity_keys: keys,
        projection_count: projections.length,
        discrepancy_count: discrepancyCount,
        output_digest: outputDigest,
      };
    } catch (error) {
      try { await repository.failRun(runId, error); } catch {}
      throw error;
    }
  }

  async function ingestObservations(inputs, { ingestionSource = 'portfolio-reconciler-api', ingestionRunId = null } = {}) {
    const source = requireString(ingestionSource, 'ingestion_source', { max: 128 });
    const rows = await normalizeBatch(inputs);
    const existingRows = await repository.findObservationsByKeys(rows.map((row) => row.idempotency_key));
    const existing = new Map(existingRows.map((row) => [row.idempotency_key, row]));
    const insert = [];
    let idempotent = 0;
    for (const row of rows) {
      const prior = existing.get(row.idempotency_key);
      if (!prior) {
        insert.push({ ...row, ingestion_source: source, ingestion_run_id: ingestionRunId });
        continue;
      }
      if (immutableSignature(prior) !== immutableSignature(row)) {
        throw codedError('OBSERVATION_IDEMPOTENCY_CONFLICT', 'idempotency key already exists with different content', {
          idempotency_key: row.idempotency_key,
        });
      }
      idempotent += 1;
    }
    if (insert.length) await repository.insertObservations(insert);
    const entityKeys = [...new Set(rows.map((row) => row.entity_key))].sort();
    const reconciliation = await reconcileEntities({ entityKeys });
    return {
      schema: 'portfolio-observation-ingestion-v1',
      inserted: insert.length,
      idempotent,
      entity_keys: entityKeys,
      reconciliation,
    };
  }

  return {
    ingestObservations,
    reconcileEntities,
    getStatus: () => repository.getStatus(),
    listEntities: (filters = {}) => repository.listProjections(filters),
    listOwnerDecisions: () => repository.listProjections({ ownerOnly: true }),
  };
}

export function createPostgresRepository(db) {
  return {
    async findObservationsByKeys(keys) {
      const rows = [];
      for (const key of keys) {
        const result = await db.query('SELECT * FROM portfolio_observations WHERE idempotency_key = $1', [key]);
        if (result.rows[0]) rows.push(result.rows[0]);
      }
      return rows;
    },

    async insertObservations(rows) {
      const statements = rows.map((row) => ({
        sql: `INSERT INTO portfolio_observations(
          idempotency_key,source_system,entity_type,entity_key,fact_type,observed_at,
          source_revision,payload,payload_canonical,payload_sha256,ingestion_source,ingestion_run_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
        params: [
          row.idempotency_key, row.source_system, row.entity_type, row.entity_key,
          row.fact_type, row.observed_at, row.source_revision, JSON.stringify(row.payload),
          row.payload_canonical, row.payload_sha256, row.ingestion_source, row.ingestion_run_id,
        ],
      }));
      await db.transaction(statements);
    },

    async beginRun({ mode, entityKeys }) {
      const result = await db.query(
        `INSERT INTO portfolio_reconciliation_runs(mode,outcome,requested_entity_keys)
         VALUES($1,'started',$2::jsonb) RETURNING run_id`,
        [mode, JSON.stringify(entityKeys)]
      );
      return result.rows[0].run_id;
    },

    async listEntityKeys(limit) {
      const result = await db.query(
        'SELECT DISTINCT entity_key FROM portfolio_observations ORDER BY entity_key LIMIT $1',
        [limit]
      );
      return result.rows.map((row) => row.entity_key);
    },

    async listObservationsForEntities(entityKeys) {
      const rows = [];
      for (const key of entityKeys) {
        const result = await db.query(
          `SELECT idempotency_key,source_system,entity_type,entity_key,fact_type,
                  observed_at::text,source_revision,payload,payload_canonical,payload_sha256
             FROM portfolio_observations
            WHERE entity_key=$1
            ORDER BY observed_at,source_system,idempotency_key`,
          [key]
        );
        rows.push(...result.rows);
      }
      return rows;
    },

    async commitRun(runId, projections, summary) {
      const statements = projections.map((projection) => ({
        sql: `INSERT INTO portfolio_entity_projections(
          entity_key,entity_type,projection,projection_sha256,reducer_version,input_watermark,observation_count,updated_at
        ) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,now())
        ON CONFLICT(entity_key) DO UPDATE SET
          entity_type=excluded.entity_type,
          projection=excluded.projection,
          projection_sha256=excluded.projection_sha256,
          reducer_version=excluded.reducer_version,
          input_watermark=excluded.input_watermark,
          observation_count=excluded.observation_count,
          updated_at=now()`,
        params: [
          projection.entity_key, projection.entity_type, JSON.stringify(projection),
          projection.projection_sha256, projection.reducer_version,
          projection.input_watermark, projection.observation_count,
        ],
      }));
      statements.push({
        sql: `UPDATE portfolio_reconciliation_runs SET
          outcome='completed',input_watermark=$2,source_observation_count=$3,
          affected_entity_count=$4,projection_count=$5,discrepancy_count=$6,
          output_digest=$7,completed_at=now() WHERE run_id=$1`,
        params: [
          runId, summary.input_watermark, summary.source_observation_count,
          summary.affected_entity_count, summary.projection_count,
          summary.discrepancy_count, summary.output_digest,
        ],
      });
      await db.transaction(statements);
    },

    async failRun(runId, error) {
      await db.query(
        `UPDATE portfolio_reconciliation_runs
            SET outcome='failed',error=$2,completed_at=now()
          WHERE run_id=$1`,
        [runId, String(error?.message || error).slice(0, 4000)]
      );
    },

    async getStatus() {
      const observations = await db.query('SELECT count(*)::integer AS count,max(observed_at)::text AS watermark FROM portfolio_observations');
      const projections = await db.query('SELECT count(*)::integer AS count FROM portfolio_entity_projections');
      const discrepancies = await db.query(
        `SELECT count(*)::integer AS count FROM portfolio_entity_projections
          WHERE jsonb_array_length(projection->'discrepancies') > 0`
      );
      const runs = await db.query(
        `SELECT run_id,mode,outcome,input_watermark::text,source_observation_count,
                affected_entity_count,projection_count,discrepancy_count,output_digest,error,
                started_at::text,completed_at::text
           FROM portfolio_reconciliation_runs ORDER BY started_at DESC LIMIT 20`
      );
      return {
        observation_count: observations.rows[0]?.count || 0,
        observation_watermark: observations.rows[0]?.watermark || null,
        projection_count: projections.rows[0]?.count || 0,
        projections_with_discrepancies: discrepancies.rows[0]?.count || 0,
        recent_runs: runs.rows,
      };
    },

    async listProjections({ ownerOnly = false, entityType = null, limit = 200 } = {}) {
      const bounded = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const clauses = [];
      const params = [];
      if (ownerOnly) clauses.push("(projection->'owner_action'->>'required')::boolean = true");
      if (entityType) {
        params.push(String(entityType));
        clauses.push(`entity_type = $${params.length}`);
      }
      params.push(bounded);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await db.query(
        `SELECT projection FROM portfolio_entity_projections ${where}
         ORDER BY entity_key LIMIT $${params.length}`,
        params
      );
      return result.rows.map((row) => row.projection);
    },
  };
}

export function createPostgresPortfolioService(db) {
  return createPortfolioService(createPostgresRepository(db));
}

export const limits = Object.freeze({ max_batch: MAX_BATCH, max_reconcile: MAX_RECONCILE });
export const patterns = Object.freeze({ sha256: SHA256 });