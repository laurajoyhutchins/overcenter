import { canonicalJson, sha256Text } from './canonical-json.js';
import { createPortfolioService, createPostgresRepository } from './store.js';

const SHA256 = /^[0-9a-f]{64}$/;
const DISPOSITIONS = new Set(['completed', 'blocked', 'pivoted', 'no_change', 'handed_off']);
const MAX_SEARCH = 200;

function codedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requiredString(value, name, max = 2000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) {
    throw codedError('PORTFOLIO_REQUEST_INVALID', `${name} is invalid`, { field: name });
  }
  return text;
}

function optionalString(value, max = 2000) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > max) {
    throw codedError('PORTFOLIO_REQUEST_INVALID', 'optional string is invalid');
  }
  return text;
}

function boundedStrings(value, maxItems = 50, maxLength = 512) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw codedError('PORTFOLIO_REQUEST_INVALID', `expected no more than ${maxItems} string values`);
  }
  return [...new Set(value.map((item) => requiredString(item, 'array item', maxLength)))].sort();
}

function canonicalNow(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw codedError('PORTFOLIO_REQUEST_INVALID', 'clock returned an invalid timestamp');
  }
  return parsed.toISOString();
}

function plusMilliseconds(iso, amount) {
  return new Date(Date.parse(iso) + amount).toISOString();
}

function afterProjection(value, projection) {
  const nowIso = canonicalNow(value);
  const nowTime = Date.parse(nowIso);
  const watermarkTime = Date.parse(String(projection?.input_watermark || ''));
  if (!Number.isFinite(watermarkTime)) return nowIso;
  return new Date(Math.max(nowTime, watermarkTime + 1)).toISOString();
}

function dispositionState(disposition, currentState) {
  return {
    completed: 'completed',
    blocked: 'blocked',
    pivoted: 'in_progress',
    no_change: currentState || 'in_progress',
    handed_off: 'ready',
  }[disposition];
}

function searchable(projection) {
  return canonicalJson({
    entity_key: projection.entity_key,
    entity_type: projection.entity_type,
    portfolio: projection.portfolio,
    dependencies: projection.dependencies,
    lore: projection.lore,
    deciduous: projection.deciduous,
    github: projection.github,
    execution: projection.execution,
    next_action: projection.next_action,
  }).toLowerCase();
}

function sourceTypes(projection) {
  const types = new Set(Object.keys(projection.source_revisions || {}));
  if (projection.lore?.records?.length || projection.lore?.findings?.length || projection.lore?.proposals?.length) {
    types.add('lore');
  }
  if (projection.deciduous?.nodes?.length || projection.deciduous?.outcomes?.length) {
    types.add('deciduous');
  }
  if (projection.portfolio?.semantic_key) types.add('portfolio');
  return [...types].sort();
}

function summary(projection) {
  return {
    entity_key: projection.entity_key,
    entity_type: projection.entity_type,
    revision: projection.projection_sha256,
    semantic_key: projection.portfolio?.semantic_key ?? null,
    title: projection.portfolio?.title ?? null,
    repository: projection.portfolio?.repository ?? null,
    state: projection.portfolio?.state ?? projection.lifecycle ?? null,
    priority: projection.portfolio?.priority ?? null,
    route: projection.portfolio?.route ?? null,
    risk_class: projection.portfolio?.risk_class ?? null,
    executable: Boolean(projection.executable),
    terminal: Boolean(projection.terminal),
    blockers: projection.blockers ?? [],
    owner_action_required: Boolean(projection.owner_action?.required),
    next_action: projection.next_action ?? null,
    source_types: sourceTypes(projection),
  };
}

async function requestFingerprint(value) {
  return sha256Text(canonicalJson(value));
}

function exactReplay(existing, fingerprint) {
  return existing?.payload?.request_fingerprint === fingerprint;
}

function rejectedTransition(projection, idempotencyKey) {
  return projection.portfolio?.rejected_transitions?.find(
    (item) => item.idempotency_key === idempotencyKey
  ) ?? null;
}

function rejectedDecision(projection, idempotencyKey) {
  return projection.owner_action?.rejected?.find(
    (item) => item.idempotency_key === idempotencyKey
  ) ?? null;
}

function staleError(entityKey, expectedRevision, projection, rejected = null) {
  return codedError('PORTFOLIO_REVISION_STALE', 'portfolio projection revision has changed', {
    entity_key: entityKey,
    expected_revision: expectedRevision,
    current_revision: rejected?.actual_revision ?? projection.projection_sha256,
  });
}

function observationBase({
  idempotencyKey,
  entityKey,
  factType,
  sourceSystem,
  observedAt,
  sourceRevision,
  payload,
}) {
  return {
    idempotency_key: idempotencyKey,
    source_system: sourceSystem,
    entity_type: 'work_item',
    entity_key: entityKey,
    fact_type: factType,
    observed_at: observedAt,
    source_revision: sourceRevision,
    payload,
  };
}

export function createWorkService(repository, { now = () => new Date().toISOString() } = {}) {
  if (!repository) throw new TypeError('repository is required');
  const portfolio = createPortfolioService(repository);

  async function fetch({ entityKey }) {
    const key = requiredString(entityKey, 'entityKey', 512);
    const projection = await repository.getProjection(key);
    if (!projection) {
      throw codedError('PORTFOLIO_ENTITY_NOT_FOUND', `No portfolio entity exists for ${key}`, {
        entity_key: key,
      });
    }
    return projection;
  }

  async function search({
    query = null,
    repository: repositoryFilter = null,
    lifecycle = null,
    route = null,
    sourceType = null,
    limit = 50,
  } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_SEARCH);
    const queryText = optionalString(query, 512)?.toLowerCase() ?? null;
    const repositoryText = optionalString(repositoryFilter, 512);
    const lifecycleText = optionalString(lifecycle, 64)?.toLowerCase() ?? null;
    const routeText = optionalString(route, 128)?.toLowerCase() ?? null;
    const sourceText = optionalString(sourceType, 64)?.toLowerCase() ?? null;
    const candidates = await repository.listProjections({ limit: 500 });
    const items = candidates
      .filter((projection) => !queryText || searchable(projection).includes(queryText))
      .filter((projection) => !repositoryText || projection.portfolio?.repository === repositoryText)
      .filter((projection) => !lifecycleText
        || String(projection.portfolio?.state ?? projection.lifecycle ?? '').toLowerCase() === lifecycleText)
      .filter((projection) => !routeText
        || String(projection.portfolio?.route ?? '').toLowerCase() === routeText)
      .filter((projection) => !sourceText || sourceTypes(projection).includes(sourceText))
      .sort((a, b) => String(a.entity_key).localeCompare(String(b.entity_key)))
      .slice(0, boundedLimit)
      .map(summary);
    return { schema: 'portfolio-search-results-v1', count: items.length, items };
  }

  async function recordWorkOutcome(input) {
    const entityKey = requiredString(input?.entityKey, 'entityKey', 512);
    const expectedRevision = requiredString(input?.expectedRevision, 'expectedRevision', 64);
    if (!SHA256.test(expectedRevision)) {
      throw codedError('PORTFOLIO_REQUEST_INVALID', 'expectedRevision must be a SHA-256 digest');
    }
    const idempotencyKey = requiredString(input?.idempotencyKey, 'idempotencyKey', 400);
    const disposition = requiredString(input?.disposition, 'disposition', 32).toLowerCase();
    if (!DISPOSITIONS.has(disposition)) {
      throw codedError('PORTFOLIO_REQUEST_INVALID', 'disposition is invalid');
    }
    const summaryText = requiredString(input?.summary, 'summary', 4000);
    const evidence = boundedStrings(input?.evidence, 50, 512);
    const deciduousOutcome = input?.deciduousOutcome && typeof input.deciduousOutcome === 'object'
      ? {
          outcomeId: requiredString(input.deciduousOutcome.outcomeId, 'deciduousOutcome.outcomeId', 256),
          status: optionalString(input.deciduousOutcome.status, 64) ?? disposition,
          summary: requiredString(input.deciduousOutcome.summary, 'deciduousOutcome.summary', 4000),
          evidence: boundedStrings(input.deciduousOutcome.evidence ?? evidence, 50, 512),
        }
      : null;
    const loreProposal = input?.loreProposal && typeof input.loreProposal === 'object'
      ? {
          proposalId: requiredString(input.loreProposal.proposalId, 'loreProposal.proposalId', 256),
          title: requiredString(input.loreProposal.title, 'loreProposal.title', 512),
          summary: requiredString(input.loreProposal.summary, 'loreProposal.summary', 4000),
        }
      : null;
    const logical = {
      entityKey,
      expectedRevision,
      disposition,
      summary: summaryText,
      evidence,
      deciduousOutcome,
      loreProposal,
    };
    const fingerprint = await requestFingerprint(logical);
    const primaryKey = `${idempotencyKey}/transition`;
    const [existing] = await repository.findObservationsByKeys([primaryKey]);
    if (existing) {
      if (!exactReplay(existing, fingerprint)) {
        throw codedError(
          'OBSERVATION_IDEMPOTENCY_CONFLICT',
          'idempotency key already exists with different outcome content',
          { idempotency_key: primaryKey }
        );
      }
      const projection = await fetch({ entityKey });
      const rejected = rejectedTransition(projection, primaryKey);
      if (rejected) throw staleError(entityKey, expectedRevision, projection, rejected);
      return {
        schema: 'portfolio-work-outcome-v1',
        replayed: true,
        revision: projection.projection_sha256,
        projection,
      };
    }

    const current = await fetch({ entityKey });
    if (current.projection_sha256 !== expectedRevision) {
      throw staleError(entityKey, expectedRevision, current);
    }

    const timestamp = afterProjection(now(), current);
    const observations = [
      observationBase({
        idempotencyKey: primaryKey,
        entityKey,
        factType: 'portfolio.transition',
        sourceSystem: 'portfolio',
        observedAt: timestamp,
        sourceRevision: `outcome:${fingerprint}`,
        payload: {
          expected_revision: expectedRevision,
          disposition,
          state: dispositionState(disposition, current.portfolio?.state),
          summary: summaryText,
          evidence,
          request_fingerprint: fingerprint,
        },
      }),
    ];
    if (deciduousOutcome) {
      observations.push(observationBase({
        idempotencyKey: `${idempotencyKey}/deciduous`,
        entityKey,
        factType: 'deciduous.outcome',
        sourceSystem: 'deciduous',
        observedAt: plusMilliseconds(timestamp, 1),
        sourceRevision: `outcome:${fingerprint}`,
        payload: {
          outcome_id: deciduousOutcome.outcomeId,
          status: deciduousOutcome.status,
          summary: deciduousOutcome.summary,
          evidence: deciduousOutcome.evidence,
          request_fingerprint: fingerprint,
        },
      }));
    }
    if (loreProposal) {
      observations.push(observationBase({
        idempotencyKey: `${idempotencyKey}/lore`,
        entityKey,
        factType: 'lore.proposal',
        sourceSystem: 'lore',
        observedAt: plusMilliseconds(timestamp, 2),
        sourceRevision: `proposal:${fingerprint}`,
        payload: {
          proposal_id: loreProposal.proposalId,
          title: loreProposal.title,
          status: 'proposed',
          summary: loreProposal.summary,
          request_fingerprint: fingerprint,
        },
      }));
    }

    const ingestion = await portfolio.ingestObservations(observations, {
      ingestionSource: 'portfolio-work-outcome',
      ingestionRunId: fingerprint,
    });
    const projection = await fetch({ entityKey });
    const rejected = rejectedTransition(projection, primaryKey);
    if (rejected) throw staleError(entityKey, expectedRevision, projection, rejected);
    return {
      schema: 'portfolio-work-outcome-v1',
      replayed: false,
      revision: projection.projection_sha256,
      projection,
      ingestion,
    };
  }

  async function requestOwnerDecision(input) {
    const entityKey = requiredString(input?.entityKey, 'entityKey', 512);
    const expectedRevision = requiredString(input?.expectedRevision, 'expectedRevision', 64);
    if (!SHA256.test(expectedRevision)) {
      throw codedError('PORTFOLIO_REQUEST_INVALID', 'expectedRevision must be a SHA-256 digest');
    }
    const idempotencyKey = requiredString(input?.idempotencyKey, 'idempotencyKey', 400);
    const category = requiredString(input?.category, 'category', 128);
    const summaryText = requiredString(input?.summary, 'summary', 4000);
    const recommendedAction = requiredString(input?.recommendedAction, 'recommendedAction', 2000);
    const logical = {
      entityKey,
      expectedRevision,
      category,
      summary: summaryText,
      recommendedAction,
    };
    const fingerprint = await requestFingerprint(logical);
    const primaryKey = `${idempotencyKey}/decision`;
    const [existing] = await repository.findObservationsByKeys([primaryKey]);
    if (existing) {
      if (!exactReplay(existing, fingerprint)) {
        throw codedError(
          'OBSERVATION_IDEMPOTENCY_CONFLICT',
          'idempotency key already exists with different owner-decision content',
          { idempotency_key: primaryKey }
        );
      }
      const projection = await fetch({ entityKey });
      const rejected = rejectedDecision(projection, primaryKey);
      if (rejected) throw staleError(entityKey, expectedRevision, projection, rejected);
      return {
        schema: 'portfolio-owner-decision-request-v1',
        replayed: true,
        revision: projection.projection_sha256,
        projection,
      };
    }

    const current = await fetch({ entityKey });
    if (current.projection_sha256 !== expectedRevision) {
      throw staleError(entityKey, expectedRevision, current);
    }
    const timestamp = afterProjection(now(), current);
    const ingestion = await portfolio.ingestObservations([
      observationBase({
        idempotencyKey: primaryKey,
        entityKey,
        factType: 'owner.decision',
        sourceSystem: 'portfolio',
        observedAt: timestamp,
        sourceRevision: `owner-decision:${fingerprint}`,
        payload: {
          expected_revision: expectedRevision,
          required: true,
          category,
          summary: summaryText,
          recommended_action: recommendedAction,
          request_fingerprint: fingerprint,
        },
      }),
    ], {
      ingestionSource: 'portfolio-owner-decision',
      ingestionRunId: fingerprint,
    });
    const projection = await fetch({ entityKey });
    const rejected = rejectedDecision(projection, primaryKey);
    if (rejected) throw staleError(entityKey, expectedRevision, projection, rejected);
    return {
      schema: 'portfolio-owner-decision-request-v1',
      replayed: false,
      revision: projection.projection_sha256,
      projection,
      ingestion,
    };
  }

  return { fetch, search, recordWorkOutcome, requestOwnerDecision };
}

export function createPostgresWorkService(db, options = {}) {
  const repository = createPostgresRepository(db);
  repository.getProjection = async (entityKey) => {
    const result = await db.query(
      'SELECT projection FROM portfolio_entity_projections WHERE entity_key = $1',
      [entityKey]
    );
    return result.rows[0]?.projection ?? null;
  };
  return createWorkService(repository, options);
}

export const workServiceLimits = Object.freeze({ max_search: MAX_SEARCH });
export const allowedDispositions = Object.freeze([...DISPOSITIONS]);