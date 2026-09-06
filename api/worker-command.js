import { hatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { commandFailure } from 'lib/command-response.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
import { createWorkerCommandHandler } from 'lib/worker-command-handler.js';
import { projectAuthoringFor } from 'lib/project-authoring-overcenter-host.js';

export const access = 'admin';
export const methods = ['POST'];

export default createWorkerCommandHandler({
  providers:hatchableRuntimeProviders,
  commandFailure,
  projectAuthoringFor,
  executeSemanticWorkerCommand,
  logger:console,
});