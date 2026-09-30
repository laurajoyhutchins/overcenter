import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const OLD_CONTRACT_PATHS = [
  'contracts/authority-facts-v1',
  'contracts/computation-execution-v1',
  'contracts/observation-evidence-v1',
  '../authority-facts-v1',
  '../computation-execution-v1',
  '../observation-evidence-v1',
];

function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...filesUnder(path));
    else if (stat.isFile()) found.push(path.replaceAll('\\', '/'));
  }
  return found;
}

test('stable wire names do not encode schema versions in source type names or paths', () => {
  const exportedVersionedTypes: string[] = [];
  for (const path of filesUnder('src').filter((path) => path.endsWith('.ts'))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /export\s+(?:interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*V\d+)\b/g,
    )) {
      exportedVersionedTypes.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(exportedVersionedTypes, []);

  const stalePathReferences: string[] = [];
  const scanRoots = ['.github', 'src', 'scripts', 'test', 'experiments', 'schema'];
  const scanFiles = scanRoots
    .flatMap((root) => filesUnder(root))
    .filter((path) => path !== 'test/stable-contract-names.test.ts')
    .filter((path) => /\.(?:ts|tsx|js|json|md|ya?ml|sh|toml|go|rs)$/.test(path));
  for (const path of scanFiles) {
    const text = readFileSync(path, 'utf8');
    for (const oldPath of OLD_CONTRACT_PATHS) {
      if (text.includes(oldPath)) stalePathReferences.push(`${path}: ${oldPath}`);
    }
  }
  for (const path of ['README.md', 'ARCHITECTURE.md', 'package.json', 'tsconfig.json']) {
    const text = readFileSync(path, 'utf8');
    for (const oldPath of OLD_CONTRACT_PATHS) {
      if (text.includes(oldPath)) stalePathReferences.push(`${path}: ${oldPath}`);
    }
  }
  assert.deepEqual(stalePathReferences, []);
});
