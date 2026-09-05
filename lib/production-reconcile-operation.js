const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;

export class ProductionReconciliationFailure extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options.cause ? { cause:options.cause } : undefined);
    this.name = 'ProductionReconciliationFailure';
    this.code = code;
    this.may_have_mutated = options.may_have_mutated === true;
    this.details = options.details || null;
  }
}

function fail(code, message = code, options = {}) {
  throw new ProductionReconciliationFailure(code, message, options);
}

function normalizeIntent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'request must be an object');
  const unknown = Object.keys(raw).filter((key) => key !== 'repo').sort();
  if (unknown.length) fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'request contains unsupported fields', { details:{ unsupported_fields:unknown } });
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  if (!REPO.test(repo)) fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'repo must be owner/repo', { details:{ field:'repo' } });
  return Object.freeze({ repo });
}

function exactRevision(value, field) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) fail('PRODUCTION_RECONCILIATION_AUTHORITY_INVALID', `${field} must be an exact Git revision`, { details:{ field } });
  return revision;
}

function evidenceRef(value, field) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref) fail('PRODUCTION_RECONCILIATION_EVIDENCE_INVALID', `${field} is required`, { details:{ field } });
  return ref;
}

function requiredPort(ports, name) {
  if (typeof ports?.[name] !== 'function') fail('PRODUCTION_RECONCILIATION_TRANSPORT_UNAVAILABLE', `${name} port is required`, { details:{ port:name } });
  return ports[name];
}

function normalizeRoles(raw) {
  const development = typeof raw?.development === 'string' ? raw.development.trim() : '';
  const production = typeof raw?.production === 'string' ? raw.production.trim() : '';
  if (!development || !production || development === production) fail('PRODUCTION_RECONCILIATION_BRANCH_ROLES_INVALID');
  return Object.freeze({ development, production });
}

function normalizeHeads(raw) {
  return Object.freeze({
    development_revision:exactRevision(raw?.development_revision, 'development_revision'),
    production_revision:exactRevision(raw?.production_revision, 'production_revision'),
  });
}

function normalizeDevelopmentVerification(raw, revision) {
  const observed = exactRevision(raw?.revision, 'verification.revision');
  if (raw?.verified !== true || observed !== revision) fail('PRODUCTION_RECONCILIATION_SOURCE_NOT_VERIFIED');
  return Object.freeze({ revision:observed, verification_ref:evidenceRef(raw?.verification_ref, 'verification.verification_ref') });
}

function normalizeRuntime(raw, expectedRevision, { allowStale = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const revision = typeof raw.revision === 'string' && SHA40.test(raw.revision.trim().toLowerCase()) ? raw.revision.trim().toLowerCase() : null;
  const verified = raw.verified === true;
  const verificationRef = typeof raw.verification_ref === 'string' ? raw.verification_ref.trim() : '';
  const deploymentVersion = Number(raw.deployment_version);
  if (allowStale && (!verified || revision !== expectedRevision || !verificationRef || !Number.isSafeInteger(deploymentVersion) || deploymentVersion < 1)) return null;
  if (!verified || revision !== expectedRevision || !verificationRef || !Number.isSafeInteger(deploymentVersion) || deploymentVersion < 1) {
    fail('PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH', 'runtime evidence does not bind the selected production revision');
  }
  return Object.freeze({ revision, verification_ref:verificationRef, deployment_version:deploymentVersion });
}

function success(outcome, intent, revision, developmentVerification, runtime) {
  return Object.freeze({
    ok:true,
    outcome,
    repo:intent.repo,
    development_revision:revision,
    production_revision:revision,
    runtime_revision:runtime.revision,
    promotion_verification_ref:developmentVerification.verification_ref,
    runtime_verification_ref:runtime.verification_ref,
    deployment_version:runtime.deployment_version,
  });
}

function rethrowMutationFailure(error, fallbackCode) {
  if (error instanceof ProductionReconciliationFailure) throw error;
  throw new ProductionReconciliationFailure(error?.code || fallbackCode, String(error?.message || error || fallbackCode), {
    cause:error,
    may_have_mutated:error?.may_have_mutated === true,
    details:error?.details || null,
  });
}

export async function reconcileProduction(rawIntent, ports) {
  const intent = normalizeIntent(rawIntent);
  const resolveBranchRoles = requiredPort(ports, 'resolveBranchRoles');
  const readBranchHeads = requiredPort(ports, 'readBranchHeads');
  const verifyDevelopmentRevision = requiredPort(ports, 'verifyDevelopmentRevision');
  const observeRuntime = requiredPort(ports, 'observeRuntime');
  const promote = requiredPort(ports, 'promote');
  const observeMaterialization = requiredPort(ports, 'observeMaterialization');
  const verifyFinalState = requiredPort(ports, 'verifyFinalState');

  const roles = normalizeRoles(await resolveBranchRoles(intent.repo));
  let heads = normalizeHeads(await readBranchHeads(intent.repo, roles));
  const selectedRevision = heads.development_revision;
  const developmentVerification = normalizeDevelopmentVerification(
    await verifyDevelopmentRevision(intent.repo, selectedRevision), selectedRevision,
  );

  const initialRuntime = normalizeRuntime(await observeRuntime(intent.repo, selectedRevision), selectedRevision, { allowStale:true });
  if (heads.production_revision === selectedRevision && initialRuntime) {
    const finalState = await verifyFinalState(intent.repo, selectedRevision);
    const finalProduction = exactRevision(finalState?.production_revision, 'final.production_revision');
    const finalRuntime = normalizeRuntime(finalState?.runtime, selectedRevision);
    if (finalProduction !== selectedRevision) fail('PRODUCTION_RECONCILIATION_FINAL_DRIFT');
    return success('already_converged', intent, selectedRevision, developmentVerification, finalRuntime);
  }

  let mutationObserved = false;
  if (heads.production_revision !== selectedRevision) {
    let promotion;
    try { promotion = await promote({ repo:intent.repo }); }
    catch (error) { rethrowMutationFailure(error, 'PRODUCTION_RECONCILIATION_PROMOTION_FAILED'); }
    mutationObserved = true;
    if (promotion?.ok !== true || exactRevision(promotion?.source_revision, 'promotion.source_revision') !== selectedRevision || exactRevision(promotion?.production_revision, 'promotion.production_revision') !== selectedRevision) {
      fail('PRODUCTION_RECONCILIATION_PROMOTION_MISMATCH', 'promotion did not report the selected exact revision', { may_have_mutated:true });
    }
    heads = normalizeHeads(await readBranchHeads(intent.repo, roles));
    if (heads.development_revision !== selectedRevision || heads.production_revision !== selectedRevision) {
      fail('PRODUCTION_RECONCILIATION_PRODUCTION_DRIFT', 'production authority did not remain bound to the selected revision after promotion', {
        may_have_mutated:true,
        details:{ selected_revision:selectedRevision, development_revision:heads.development_revision, production_revision:heads.production_revision },
      });
    }
  }

  let materialization;
  try { materialization = await observeMaterialization(intent.repo, selectedRevision); }
  catch (error) { rethrowMutationFailure(error, 'PRODUCTION_RECONCILIATION_MATERIALIZATION_OBSERVATION_FAILED'); }
  const state = String(materialization?.state || '').trim();
  if (['pending','queued','in_progress'].includes(state)) {
    fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_PENDING', 'exact production materialization is still in progress', {
      may_have_mutated:mutationObserved,
      details:{ revision:selectedRevision, state },
    });
  }
  if (state !== 'succeeded') {
    fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_UNAVAILABLE', 'exact production materialization is not verified successful', {
      may_have_mutated:mutationObserved,
      details:{ revision:selectedRevision, state:state || null },
    });
  }
  if (exactRevision(materialization?.revision, 'materialization.revision') !== selectedRevision) {
    fail('PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH', 'materialization evidence names a different revision', { may_have_mutated:mutationObserved });
  }
  evidenceRef(materialization?.verification_ref, 'materialization.verification_ref');
  const materializationVersion = Number(materialization?.deployment_version);
  if (!Number.isSafeInteger(materializationVersion) || materializationVersion < 1) {
    fail('PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH', 'materialization evidence lacks a deployment version', { may_have_mutated:mutationObserved });
  }

  const finalState = await verifyFinalState(intent.repo, selectedRevision);
  const finalProduction = exactRevision(finalState?.production_revision, 'final.production_revision');
  if (finalProduction !== selectedRevision) {
    fail('PRODUCTION_RECONCILIATION_FINAL_DRIFT', 'production moved before final convergence proof', { may_have_mutated:mutationObserved });
  }
  const finalRuntime = normalizeRuntime(finalState?.runtime, selectedRevision);
  return success('converged', intent, selectedRevision, developmentVerification, finalRuntime);
}