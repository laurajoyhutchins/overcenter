function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} dependency is required`);
  return value;
}

function safeInputShape(input) {
  if (Array.isArray(input)) return { input_type:'array' };
  if (!input || typeof input !== 'object') return { input_type:input === null ? 'null' : typeof input };
  const shape = {};
  for (const key of Object.keys(input).sort().slice(0, 20)) {
    const value = input[key];
    shape[key] = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
  }
  return shape;
}

function requiresProjectAuthoring(command) {
  return command === 'project.define' || command === 'project.amend';
}

export function createWorkerCommandHandler(options = {}) {
  const commandFailure = requireFunction(options.commandFailure, 'commandFailure');
  const executeSemanticWorkerCommand = requireFunction(options.executeSemanticWorkerCommand, 'executeSemanticWorkerCommand');
  const projectAuthoringFor = requireFunction(options.projectAuthoringFor, 'projectAuthoringFor');
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : console;
  const db = options.db;

  return async function workerCommandHandler(req, res) {
    const command = typeof req.body?.command === 'string' ? req.body.command : '';
    const input = req.body?.input;
    if (!command) {
      const response = commandFailure('work.claim', {
        code:'REQUEST_INVALID',
        message:'command is required',
        details:{ field:'command' },
      }, { flattenDetails:true, http_status:400 });
      return res.status(response.status).json(response.body);
    }

    const runtime = {
      db,
      ...(req.body?.invocation_context === undefined ? {} : { invocationContext:req.body.invocation_context }),
    };
    if (requiresProjectAuthoring(command)) runtime.projectAuthoring = projectAuthoringFor(runtime);
    const response = await executeSemanticWorkerCommand(command, input, runtime);
    if (response.status >= 400) {
      logger.warn(JSON.stringify({
        event:'worker_command_rejected',
        command,
        error:response.body?.error || null,
        field:response.body?.field || response.body?.details?.field || null,
        input_shape:safeInputShape(input),
      }));
    }
    return res.status(response.status).json(response.body);
  };
}
