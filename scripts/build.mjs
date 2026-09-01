import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const tsc = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));
const mirrorFiles = [
  'canonical-commands.js',
  'command-contracts.js',
  'compact-execution-state.js',
  'compatibility-transition-bindings.js',
  'execution-authority-contracts.js',
  'execution-authority-core.js',
  'legacy-work-execution-authority-contracts.js',
  'execution-evidence-contracts.js',
  'execution-evidence.js',
  'execution-lifecycle-contracts.js',
  'mutation-certainty.js',
  'orchestration-drive.js',
  'production-materialization-operation.js',
  'project-authoring-command-contract.js',
  'project-authoring-github-runtime.js',
  'project-authoring-runtime.js',
  'project-authoring-work-branch.js',
  'project-authoring.js',
  'project-definition-changeset-writer.js',
  'project-definition-mutation-authority.js',
  'project-graph-contracts.js',
  'project-graph-reconciliation.js',
  'semantic-command-descriptors.js',
  'work-settle-contract.js',
];

function runTsc(config) {
  const result = spawnSync(process.execPath, [tsc, '-p', config], { cwd: fileURLToPath(root), stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function verifyRuntimeMirrors() {
  const mismatches = [];
  for (const file of mirrorFiles) {
    const tracked = await readFile(new URL(`lib/${file}`, root));
    const generated = await readFile(new URL(`dist/lib/${file}`, root));
    if (!tracked.equals(generated)) mismatches.push(file);
  }
  if (mismatches.length) {
    console.error(`Generated semantic runtime drift: ${mismatches.join(', ')}`);
    process.exit(1);
  }
}

async function buildRuntime() {
  await rm(new URL('dist/lib/', root), { recursive: true, force: true });
  runTsc('tsconfig.semantic.runtime.json');
  await verifyRuntimeMirrors();
}

async function buildPortable() {
  await rm(new URL('dist/portable/', root), { recursive: true, force: true });
  runTsc('tsconfig.portable-runtime.json');
}

const mode = process.argv[2] || 'all';
if (!['all', 'typecheck', 'runtime', 'portable'].includes(mode)) {
  console.error(`Unknown build mode: ${mode}`);
  process.exit(2);
}
if (mode === 'all' || mode === 'typecheck') runTsc('tsconfig.semantic.json');
if (mode === 'all' || mode === 'runtime') await buildRuntime();
if (mode === 'all' || mode === 'portable') await buildPortable();
