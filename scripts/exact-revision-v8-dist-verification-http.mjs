import { pathToFileURL } from 'node:url';
import {
  createCheckoutSourceAdapter,
  createHatchableRuntimeAdapter,
  verificationInputFromEnv,
  verifyExactRevisionV8,
} from './exact-revision-v8-verification.mjs';
import { connectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';
import { createRuntimeArtifactSourceAdapter } from './runtime-artifact-source.mjs';

export async function runDistVerificationHttpCli(env = process.env) {
  const { token, input } = verificationInputFromEnv(env);
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const result = await verifyExactRevisionV8(input, {
      source: createRuntimeArtifactSourceAdapter(createCheckoutSourceAdapter()),
      runtime: createHatchableRuntimeAdapter({ callTool: connection.callTool }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDistVerificationHttpCli().then(result => {
    if (result.ok !== true) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok:false, error:error?.code || 'EXACT_REVISION_V8_DIST_VERIFICATION_FAILED', message:String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
