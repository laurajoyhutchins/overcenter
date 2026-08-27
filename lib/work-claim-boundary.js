import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalClaimCommand } from 'lib/operator-commands.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export async function executeWorkClaimBoundary(args = {}, options = {}) {
  const dbBinding = options.db || db;
  const failureOptions = {
    statusForFailure: statusForWorkLeaseError,
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
    flattenDetails: true,
    db: dbBinding,
    logger: options.logger,
  };

  let input;
  try {
    input = await canonicalClaimCommand(args || {}, dbBinding);
  } catch (error) {
    return workerBoundaryCommandFailure('work.claim', error, failureOptions);
  }

  const service = options.service || createPostgresWorkLeaseService({ db: dbBinding });
  return executeCorrelatedCommand(
    'work.claim',
    input,
    (request) => service.claim(request),
    workerBoundaryFailureOptions('work.claim', failureOptions),
  );
}