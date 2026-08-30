import { db as hatchableDb } from 'hatchable';
import { commandFailure } from 'lib/command-response.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
import { createWorkerCommandHandler } from 'lib/worker-command-handler.js';
import { projectAuthoringFor } from 'lib/project-authoring-overcenter-host.js';

export const access = 'admin';
export const methods = ['POST'];

export default createWorkerCommandHandler({
  db:hatchableDb,
  commandFailure,
  projectAuthoringFor,
  executeSemanticWorkerCommand,
  logger:console,
});