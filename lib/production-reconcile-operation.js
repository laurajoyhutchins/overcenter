const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;

export class ProductionReconciliationFailure extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'request must be an object');
  }
  const unsupported = Object.keys(raw).filter(key => key !== 'repo').sort();
  if (unsupported.length) {
    fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'request contains unsupported mechanical coordinates', {
      details: { unsupported_fields: unsupported },
    });
  }
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  if (!REPOSITORY.test(repo)) {
    fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'repo must be owner/repository', { details: { field: 'repo' } });
  }
  return Object.freeze({ repo });
}

function exactRevision(value, field) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) {
    fail('PRODUCTION_RECONCILIATION_AUTHORITY_INVALID', `${field} must be an exact Git revision`, { details: { field } });
  }
  return revision;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    fail('PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH', `${field} must be a positive integer`, { details: { field } });
  }
  return number;
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail('PRODUCTION_RECONCILIATION_EVIDENCE_INVALID', `${field} is required`, { details: { field } });
  return text;
}

function requiredPort(ports, name) {
  const port = ports?.[name];
  if (typeof port !== 'function') {
    fail('PRODUCTION_RECONCILIATION_TRANSPORT_UNAVAILABLE', `${name} port is required`, { details: { port: name } });
  }
  return port;
}

function normalizeRoles(raw) {
  const development = typeof raw?.development === 'string' ? raw.development.trim() : '';
  const production = typeof raw?.production === 'string' ? raw.production.trim() : '';
  if (!development || !production || development === production) {
    fail('PRODUCTION_RECONCILIATION_BRANCH_ROLES_INVALID', 'development and production roles must be distinct');
  }
  return Object.freeze({ development, production });
}

function normalizeHeads(raw) {
  return Object.freeze({
    development_revision: exactRevision(raw?.development_revision, 'development_revision'),
    production_revision: exactRevision(raw?.production_revision, 'production_revision'),
  });
}

function normalizeDevelopmentVerification(raw, selectedRevision) {
  const revision = exactRevision(raw?.revision, 'development_verification.revision');
  if (raw?.verified !== true || revision !== selectedRevision) {
    fail('PRODUCTION_RECONCILIATION_SOURCE_NOT_VERIFIED', 'development verification does not authorize the selected exact revision');
  }
  return Object.freeze({
    revision,
    verification_ref: requiredText(raw?.verification_ref, 'development_verification.verification_ref'),
  });
}

function verifiedRuntime(raw, selectedRevision, { allowStale = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const revision = typeof raw.revision === 'string' ? raw.revision.trim().toLowerCase() : '';
  const verificationRef = typeof raw.verification_ref === 'string' ? raw.verification_ref.trim() : '';
  const version = Number(raw.deployment_version);
  const valid = raw.verified === true
    && revision === selectedRevision
    && SHA40.test(revision)
    && Boolean(verificationRef)
    && Number.isSafeInteger(version)
    && version >= 1;
  if (!valid && allowStale) return null;
  if (!valid) {
    fail('PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH', 'runtime evidence does not bind the selected exact revision');
  }
  return Object.freeze({ revision, verification_ref: verificationRef, deployment_version: version });
}

function mutationFailure(error, fallbackCode, fallbackMayHaveMutated = false) {
  if (error instanceof ProductionReconciliationFailure) throw error;
  throw new ProductionReconciliationFailure(error?.code || fallbackCode, String(error?.message || error || fallbackCode), {
    cause: error,
    may_have_mutated: error?.may_have_mutated === true || fallbackMayHaveMutated,
    details: error?.details || null,
  });
}

function success(outcome, intent, selectedRevision, developmentVerification, runtime) {
  return Object.freeze({
    ok: true,
    outcome,
    repo: intent.repo,
    development_revision: selectedRevision,
    production_revision: selectedRevision,
    runtime_revision: runtime.revision,
    development_verification_ref: developmentVerification.verification_ref,
    runtime_verification_ref: runtime.verification_ref,
    deployment_version: runtime.deployment_version,
  });
}

function pending(intent, selectedRevision, developmentVerification, materialization, mayHaveMutated) {
  const state = String(materialization?.state || '').trim();
  const runRef = typeof materialization?.run_ref === 'string' && materialization.run_ref.trim()
    ? materialization.run_ref.trim()
    : null;
  return Object.freeze({
    ok: true,
    outcome: 'materialization_pending',
    repo: intent.repo,
    development_revision: selectedRevision,
    production_revision: selectedRevision,
    development_verification_ref: developmentVerification.verification_ref,
    materialization_state: state,
    materialization_run_ref: runRef,
    may_have_mutated: mayHaveMutated === true || materialization?.mutation_attempted === true,
  });
}

export async function reconcileProduction(rawIntent, ports = {}) {
  const intent = normalizeIntent(rawIntent);
  const resolveBranchRoles = requiredPort(ports, 'resolveBranchRoles');
  const readBranchHeads = requiredPort(ports, 'readBranchHeads');
  const verifyDevelopmentRevision = requiredPort(ports, 'verifyDevelopmentRevision');
  const observeRuntime = requiredPort(ports, 'observeRuntime');
  const promote = requiredPort(ports, 'promote');
  const reconcileRuntime = requiredPort(ports, 'reconcileRuntime');
  const verifyFinalState = requiredPort(ports, 'verifyFinalState');

  const roles = normalizeRoles(await resolveBranchRoles(intent.repo));
  let heads = normalizeHeads(await readBranchHeads(intent.repo, roles));
  const selectedRevision = heads.development_revision;
  const developmentVerification = normalizeDevelopmentVerification(
    await verifyDevelopmentRevision(intent.repo, selectedRevision),
    selectedRevision,
  );
  const initialRuntime = verifiedRuntime(
    await observeRuntime(intent.repo, selectedRevision, roles),
    selectedRevision,
    { allowStale: true },
  );

  if (heads.production_revision === selectedRevision && initialRuntime) {
    const finalState = await verifyFinalState(intent.repo, selectedRevision, roles);
    const finalDevelopment = exactRevision(finalState?.development_revision, 'final.development_revision');
    const finalProduction = exactRevision(finalState?.production_revision, 'final.production_revision');
    const finalRuntime = verifiedRuntime(finalState?.runtime, selectedRevision);
    if (finalDevelopment !== selectedRevision || finalProduction !== selectedRevision) {
      fail('PRODUCTION_RECONCILIATION_FINAL_DRIFT', 'Git authority moved before final convergence proof');
    }
    return success('already_converged', intent, selectedRevision, developmentVerification, finalRuntime);
  }

  let mayHaveMutated = false;
  if (heads.production_revision !== selectedRevision) {
    let promotion;
    try {
      promotion = await promote({ repo: intent.repo });
    } catch (error) {
      mutationFailure(error, 'PRODUCTION_RECONCILIATION_PROMOTION_FAILED');
    }
    mayHaveMutated = true;
    const promotedSource = exactRevision(promotion?.source_revision, 'promotion.source_revision');
    const promotedProduction = exactRevision(promotion?.production_revision, 'promotion.production_revision');
    if (promotion?.ok !== true || promotedSource !== selectedRevision || promotedProduction !== selectedRevision) {
      fail('PRODUCTION_RECONCILIATION_PROMOTION_MISMATCH', 'promotion did not report the selected exact revision', { may_have_mutated: true });
    }

    heads = normalizeHeads(await readBranchHeads(intent.repo, roles));
    if (heads.development_revision !== selectedRevision || heads.production_revision !== selectedRevision) {
      fail('PRODUCTION_RECONCILIATION_GIT_DRIFT', 'Git authority moved after promotion', {
        may_have_mutated: true,
        details: {
          selected_revision: selectedRevision,
          development_revision: heads.development_revision,
          production_revision: heads.production_revision,
        },
      });
    }
  }

  let materialization;
  try {
    materialization = await reconcileRuntime(intent.repo, selectedRevision, roles);
  } catch (error) {
    mutationFailure(error, 'PRODUCTION_RECONCILIATION_MATERIALIZATION_FAILED', mayHaveMutated);
  }
  const materializationState = String(materialization?.state || '').trim();
  if (['pending', 'queued', 'in_progress'].includes(materializationState)) {
    return pending(intent, selectedRevision, developmentVerification, materialization, mayHaveMutated);
  }
  if (materializationState === 'indeterminate') {
    fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_INDETERMINATE', 'materialization effect is indeterminate', {
      may_have_mutated: true,
      details: { run_ref: materialization?.run_ref || null },
    });
  }
  if (materializationState !== 'succeeded') {
    fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_UNVERIFIED', 'materialization is not verified successful', {
      may_have_mutated: mayHaveMutated || materialization?.mutation_attempted === true,
      details: { state: materializationState || null, run_ref: materialization?.run_ref || null },
    });
  }
  if (exactRevision(materialization?.revision, 'materialization.revision') !== selectedRevision) {
    fail('PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH', 'materialization evidence names a different revision', {
      may_have_mutated: mayHaveMutated || materialization?.mutation_attempted === true,
    });
  }
  requiredText(materialization?.verification_ref, 'materialization.verification_ref');
  positiveInteger(materialization?.deployment_version, 'materialization.deployment_version');

  const finalState = await verifyFinalState(intent.repo, selectedRevision, roles);
  const finalDevelopment = exactRevision(finalState?.development_revision, 'final.development_revision');
  const finalProduction = exactRevision(finalState?.production_revision, 'final.production_revision');
  if (finalDevelopment !== selectedRevision || finalProduction !== selectedRevision) {
    fail('PRODUCTION_RECONCILIATION_FINAL_DRIFT', 'Git authority moved before final convergence proof', {
      may_have_mutated: mayHaveMutated || materialization?.mutation_attempted === true,
    });
  }
  const finalRuntime = verifiedRuntime(finalState?.runtime, selectedRevision);
  return success('converged', intent, selectedRevision, developmentVerification, finalRuntime);
}