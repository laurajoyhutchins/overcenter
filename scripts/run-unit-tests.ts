import { readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';

function testFiles(root: string): string[] {
  const absolute = resolve(root);
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (entry.isFile() && entry.name.endsWith('.test.ts')) return [path];
      return [];
    });
  return walk(absolute).map((path) => relative(process.cwd(), path));
}

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const profile = readSourceVerificationProfile(process.cwd(), revision).profile;
const files = [...new Set(profile.baseline_test_roots.flatMap(testFiles))].sort();
if (files.length === 0) throw new Error('SOURCE_PROFILE_HAS_NO_TEST_FILES');
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', '--test-concurrency=2', ...files],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
