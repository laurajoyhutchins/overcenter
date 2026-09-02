import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/build.mjs', 'portable']);
run(['--test', 'scripts/node-postgres-runtime.test.mjs']);
run(['--test', 'scripts/verify-compact-state-migrations-postgres.test.mjs']);
run(['--test', 'scripts/compact-execution-state-postgres.test.mjs']);
run(['--test', 'scripts/project-transition-compact-authority-postgres.test.mjs']);
run(['--test', 'scripts/compact-provider-operations-postgres.test.mjs']);
run(['--test', 'scripts/compact-portfolio-reconcile-postgres.test.mjs']);
run(['--test', 'scripts/compact-proof-state-postgres.test.mjs']);
run(['--test', 'scripts/compact-proof-adapter-postgres.test.mjs']);
run(['--test', 'scripts/compact-production-promotion-proof-postgres.test.mjs']);
run(['--experimental-loader=./scripts/hatchable-node-test-loader.mjs', '--test', 'scripts/compact-recovery-postgres.test.mjs']);
