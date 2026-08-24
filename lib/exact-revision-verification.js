function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function verifyExactRevision(input = {}, runtime = {}) {
  const repository = String(input.repository || '').trim();
  const revision = String(input.revision || '').trim();
  if (!nonEmpty(repository) || !nonEmpty(revision)) {
    fail('EXACT_REVISION_INPUT_INVALID', 'repository and exact revision are required');
  }
  if (typeof runtime.resolveRevision !== 'function') {
    fail('EXACT_REVISION_RESOLVER_UNAVAILABLE', 'exact revision resolver is unavailable', { repository, revision });
  }

  const resolved = await runtime.resolveRevision({ repository, revision });
  if (resolved?.repository !== repository || resolved?.revision !== revision) {
    fail('EXACT_REVISION_MISMATCH', 'requested revision did not resolve exactly', {
      repository,
      revision,
      resolved_repository:resolved?.repository || null,
      resolved_revision:resolved?.revision || null,
    });
  }

  if (typeof runtime.executeRevisionRegression !== 'function') {
    fail('EXACT_REVISION_EXECUTOR_UNAVAILABLE', 'exact revision regression executor is unavailable', { repository, revision });
  }

  const evidence = await runtime.executeRevisionRegression({ repository, revision });
  if (evidence?.repository !== repository || evidence?.revision !== revision) {
    fail('EXACT_REVISION_EVIDENCE_MISMATCH', 'regression evidence is not attributable to the requested revision', {
      repository,
      revision,
      evidence_repository:evidence?.repository || null,
      evidence_revision:evidence?.revision || null,
    });
  }
  if (evidence?.result?.schema !== 'regression-verification-v1') {
    fail('EXACT_REVISION_RESULT_INVALID', 'exact revision regression executor returned an invalid verification result', {
      repository,
      revision,
      schema:evidence?.result?.schema || null,
    });
  }

  return Object.freeze({
    ok:evidence.result.ok === true,
    schema:'exact-revision-verification-v1',
    repository,
    revision,
    regression:evidence.result,
  });
}
