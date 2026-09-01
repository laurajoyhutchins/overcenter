import { pathToFileURL } from 'node:url';
import { createCheckoutSourceAdapter } from './exact-revision-v8-verification.mjs';
import { connectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';
import {
  createProductionRuntimeAdapter,
  productionMaterializationInputFromEnv,
} from './production-materialization-http.mjs';
import { materializeProductionRevision } from './production-materialization.mjs';
import { createRuntimeArtifactSourceAdapter } from './runtime-artifact-source.mjs';

export async function runProductionMaterializationDistHttpCli(env = process.env) {
  const { token, input } = productionMaterializationInputFromEnv(env);
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const result = await materializeProductionRevision(input, {
      source: createRuntimeArtifactSourceAdapter(createCheckoutSourceAdapter()),
      runtime: createProductionRuntimeAdapter({ callTool: connection.callTool }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionMaterializationDistHttpCli().then(result => {
    if (result.ok !== true) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok:false, error:error?.code || 'PRODUCTION_MATERIALIZATION_DIST_FAILED', message:String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
