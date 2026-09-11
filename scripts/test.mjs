import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);
const TEST_FILE = /\.(?:test|spec)\.(?:js|mjs|cjs)$/;

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function filesUnder(directory, predicate) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(relative, predicate));
    else if (entry.isFile() && predicate(entry.name)) files.push(relative);
  }
  return files.sort();
}

const scriptTests = await filesUnder('scripts', (name) => TEST_FILE.test(name));
const nativeLibTests = [];
for (const file of await filesUnder('lib', (name) => TEST_FILE.test(name))) {
  const source = await readFile(new URL(file, root), 'utf8');
  if (/from\s+['\"]node:test['\"]/.test(source) || /require\(['\"]node:test['\"]\)/.test(source)) {
    nativeLibTests.push(file);
  }
}

run(['scripts/verify-regression-suite-registry.mjs']);
run(['scripts/verify-orchestration-drive.mjs']);
run(['--test', ...scriptTests, ...nativeLibTests]);

for (const directory of ['api', 'lib', 'mcp', 'pages']) {
  for (const file of await filesUnder(directory, (name) => name.endsWith('.js'))) run(['--check', file]);
}
