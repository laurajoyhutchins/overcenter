import { isSyncableSourcePath } from 'lib/source-sync.js';

export async function runSourceSyncPackageBoundaryTests() {
  const ok = !isSyncableSourcePath('package.json');
  const result = ok
    ? { name: 'root package.json remains repository-only developer metadata', ok: true }
    : { name: 'root package.json remains repository-only developer metadata', ok: false, error: 'root package.json is incorrectly classified as Hatchable runtime source' };
  return {
    ok,
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    results: [result],
  };
}