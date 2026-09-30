import { execFileSync, spawnSync } from 'node:child_process';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';

const repo = process.cwd();
const base = process.env.BASE_SHA ?? '';
if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('SOURCE_PROFILE_BASE_REVISION_REQUIRED');
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const submitted = readSourceVerificationProfile(repo, candidate);
let trusted = submitted;
try {
  trusted = readSourceVerificationProfile(repo, base);
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'SOURCE_VERIFICATION_PROFILE_MISSING')
    throw error;
  // One-time profile bootstrap: the accepted base predates repository-owned verification policy.
}
if (trusted.sha256 !== submitted.sha256) throw new Error('SOURCE_PROFILE_CANDIDATE_MISMATCH');
if (trusted !== submitted) {
  const comparison = spawnSync(
    'git',
    ['diff', '--quiet', base, candidate, '--', ...trusted.profile.protected_paths],
    { stdio: 'inherit' },
  );
  if (comparison.error) throw comparison.error;
  if (comparison.status !== 0) throw new Error('SOURCE_PROFILE_PROTECTED_PATH_CHANGED');
}

if (process.argv.includes('--check-only')) process.exit(0);

for (const command of trusted.profile.commands) {
  const [name, ...args] = command.split(' ');
  const result = spawnSync(name!, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
