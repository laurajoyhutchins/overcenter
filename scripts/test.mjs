import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function javascriptFiles(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await javascriptFiles(relative));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

const maintainedTests = [
  'codex-agent-execution-workflow.test.mjs',
  'verify-github-workflow-dispatch.test.mjs',
  'verify-root-developer-entrypoint.test.mjs',
  'verify-legacy-lane-isolation.test.mjs',
  'verify-transition-first-dashboard.test.mjs',
  'verify-execution-evidence-projector.test.mjs',
  'verify-execution-evidence-review.test.mjs',
  'verify-compact-correctness-boundary.test.mjs',
  'verify-work-lease-config.test.mjs',
  'verify-project-horizon.test.mjs',
  'verify-project-obligation-contract.test.mjs',
  'verify-project-advance-worker-binding.test.mjs',
  'verify-production-promotion-receipt-fence.test.mjs',
  'verify-production-promotion-invocation-context.test.mjs',
  'verify-project-transition-leases.test.mjs',
  'verify-project-transition-mutation-workspace-authority.test.mjs',
  'verify-project-transition-gateway-acquisition.test.mjs',
  'verify-project-transition-checkpoint-revision-evidence.test.mjs',
  'verify-project-transition-heartbeat-replay-evidence.test.mjs',
  'verify-project-transition-continuation-wiring.test.mjs',
  'verify-project-transition-revision-continuation.test.mjs',
  'verify-project-transition-settlement-atomicity.test.mjs',
  'verify-compatibility-transition-confirmation.test.mjs',
  'verify-compatibility-transition-runtime.test.mjs',
  'verify-mcp-admission-contract.test.mjs',
  'verify-semantic-command-descriptors.test.mjs',
  'verify-github-pull-request-mark-ready-semantic-worker.test.mjs',
  'verify-project-authoring.test.mjs',
  'verify-project-authoring-github-adapter.test.mjs',
  'verify-project-authoring-authoritative-transition.test.mjs',
  'verify-project-authoring-production-runtime.test.mjs',
  'verify-project-authoring-pending-envelope.test.mjs',
  'verify-project-authoring-readback-contract.test.mjs',
  'verify-project-authoring-worker-binding.test.mjs',
  'verify-project-authoring-mutation-authority.test.mjs',
  'verify-project-definition-mutation-authority.test.mjs',
  'verify-project-definition-changeset-writer.test.mjs',
  'verify-project-authoring-command-contract.test.mjs',
  'verify-project-authoring-work-branch.test.mjs',
  'verify-github-graph-authority.test.mjs',
  'verify-overcenter-project-graph-capacity.test.mjs',
  'verify-repository-metadata-command.test.mjs',
  'verify-repository-rename-command.test.mjs',
  'verify-repository-register-command.test.mjs',
  'verify-milestone-command.test.mjs',
  'verify-overcenter-terminology.test.mjs',
  'verify-public-release.test.mjs',
  'verify-public-github-metadata.test.mjs',
  'verify-repository-registration-policy.test.mjs',
  'production-reconcile-operation.test.mjs',
  'production-reconcile-host.test.mjs',
  'production-runtime-observation-http.test.mjs',
  'verify-node-test-standardization.test.mjs',
];

const scriptNames = await readdir(new URL('scripts/', root));
for (const prefix of ['exact-revision-v8-verification', 'production-materialization']) {
  maintainedTests.push(...scriptNames.filter(name => name.startsWith(prefix) && name.endsWith('.test.mjs')));
}

run(['scripts/verify-regression-suite-registry.mjs']);
run(['scripts/verify-orchestration-drive.mjs']);
run(['--test', ...[...new Set(maintainedTests)].sort().map(name => `scripts/${name}`)]);

for (const directory of ['api', 'lib', 'mcp', 'pages']) {
  for (const file of await javascriptFiles(directory)) run(['--check', file]);
}
