import { execFileSync } from 'node:child_process';
import { appendGitHubOutputs } from './project-command-runtime.ts';

const revision = process.env.OVERCENTER_PROJECT_SOURCE_SHA ?? '';
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('SOURCE_PREPARATION_TOOLS_BASE_INVALID');
const paths = [
  'src/source/source-preparation-profile.json',
  '.overcenter/source-preparation-profile.json',
];
const present = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', ...paths], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
if (present.length !== 1) throw new Error('SOURCE_PREPARATION_TOOLS_PROFILE_REQUIRED');
const profile: unknown = JSON.parse(
  execFileSync('git', ['show', `${revision}:${present[0]}`], { encoding: 'utf8' }),
);
if (
  !profile ||
  typeof profile !== 'object' ||
  !('tools' in profile) ||
  !Array.isArray(profile.tools)
)
  throw new Error('SOURCE_PREPARATION_TOOLS_PROFILE_INVALID');
const outputs: Record<string, string> = {};
for (const raw of profile.tools as unknown[]) {
  if (!raw || typeof raw !== 'object') throw new Error('SOURCE_PREPARATION_TOOLS_PROFILE_INVALID');
  const tool = raw as Record<string, unknown>;
  if (
    typeof tool.engine !== 'string' ||
    !['biome', 'gofmt', 'rustfmt', 'ruff'].includes(tool.engine) ||
    typeof tool.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(tool.version) ||
    Object.hasOwn(outputs, `${tool.engine}_version`)
  )
    throw new Error('SOURCE_PREPARATION_TOOLS_PROFILE_INVALID');
  outputs[`${tool.engine}_version`] = tool.version;
}
appendGitHubOutputs(outputs);
