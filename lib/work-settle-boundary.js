import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export async function executeWorkSettleBoundary(args = {}, options = {}) {
  const dbBinding = options.db || db;
  const failureOptions = {
    statusForFailure: statusForWorkLeaseError,
    defaultError: 'WORK_SETTLE_ERROR',
    defaultMessage: 'work.settle failed',
    flattenDetails: true,
    db: dbBinding,
    logger: options.logger,
  };

  let input;
  try {
    input = await canonicalSettleCommandByRef(args || {}, dbBinding);
  } catch (error) {
    return workerBoundaryCommandFailure('work.settle', error, failureOptions);
  }

  const service = options.service || createPostgresWorkLeaseService({ db: dbBinding });
  const executeCommand = options.executeCommand || executeCorrelatedCommand;
  return executeCommand(
    'work.settle',
    input,
    (request) => service.settleByRef(request),
    workerBoundaryFailureOptions('work.settle', failureOptions),
  );
}
