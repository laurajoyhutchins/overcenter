import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  observeGitSemanticDelta,
  semanticArtifactChanged,
} from '../scripts/plan-semantic-change.ts';
import { repositorySnapshot } from '../src/evidence/repository-snapshot.ts';
import { brokerSourceProposal } from '../src/source/source-broker.ts';
import { inspectSourceCandidate } from '../src/source/source-integration.ts';
import {
  bindSourceClaim,
  SOURCE_PROPOSAL_SCHEMA,
  SOURCE_TASK_SCHEMA,
} from '../src/source/source-obligation.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-delta-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Delta regression');
  git('config', 'user.email', 'delta@local');
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}

test('template-literal comment-looking lines remain semantic changes', () => {
  for (const prefix of ['//', '*', '/*', '*/']) {
    assert.equal(
      semanticArtifactChanged(
        'value.ts',
        `export const value = \`\n${prefix} before\n\`;`,
        `export const value = \`\n${prefix} after\n\`;`,
      ),
      true,
    );
  }
});

test('comment and whitespace changes remain conservative validation inputs', () => {
  assert.equal(semanticArtifactChanged('value.ts', '// before\n', '// after\n'), true);
  assert.equal(semanticArtifactChanged('value.ts', 'const v = ` a `;', 'const v = ` b `;'), true);
});

test('Git delta keeps literal filenames and mode-only changes', (t) => {
  const { root, commit } = fixture(t);
  for (const path of [' space.ts', '-leading.ts', 'tab\tname.ts', 'line\nname.ts', 'mode.ts']) {
    writeFileSync(join(root, path), '// before\n');
  }
  const base = commit();
  for (const path of [' space.ts', '-leading.ts', 'tab\tname.ts', 'line\nname.ts']) {
    writeFileSync(join(root, path), '// after\n');
  }
  chmodSync(join(root, 'mode.ts'), 0o755);
  const head = commit();
  assert.deepEqual(observeGitSemanticDelta(base, head, root), [
    ' space.ts',
    '-leading.ts',
    'line\nname.ts',
    'mode.ts',
    'tab\tname.ts',
  ]);
});

test('rename observation contains both deleted and added paths', (t) => {
  const { root, commit } = fixture(t);
  writeFileSync(join(root, 'before.ts'), 'export const value = 1;\n');
  const base = commit();
  renameSync(join(root, 'before.ts'), join(root, 'after.ts'));
  const head = commit();
  assert.deepEqual(observeGitSemanticDelta(base, head, root), ['after.ts', 'before.ts']);
});

test('missing revisions fail observation instead of appearing unchanged', (t) => {
  const { root, commit } = fixture(t);
  writeFileSync(join(root, 'value.ts'), 'value');
  const head = commit();
  assert.throws(() => observeGitSemanticDelta('0'.repeat(40), head, root));
});

test('symlink mode changes remain visible to source policy', (t) => {
  const { root, commit } = fixture(t);
  writeFileSync(join(root, 'value.ts'), 'value');
  const base = commit();
  rmSync(join(root, 'value.ts'));
  symlinkSync('target.ts', join(root, 'value.ts'));
  const head = commit();
  assert.deepEqual(observeGitSemanticDelta(base, head, root), ['value.ts']);
  assert.throws(
    () =>
      inspectSourceCandidate(
        root,
        {
          schema: SOURCE_TASK_SCHEMA,
          kind: 'source-change',
          objective: 'Edit value',
          writable_paths: ['value.ts'],
        },
        bindSourceClaim('key', 'run', 'revision', base),
        head,
      ),
    /SOURCE_DELTA_MODE_UNSUPPORTED/,
  );
});

test('snapshot distinguishes literal path content from absence without trimming', (t) => {
  const { root, commit } = fixture(t);
  writeFileSync(join(root, ' space.ts'), '  value\n\n');
  writeFileSync(join(root, '*'), 'literal star');
  const head = commit();
  const snapshot = repositorySnapshot(root, head);
  assert.equal(snapshot.optionalBytes(' space.ts')?.toString(), '  value\n\n');
  assert.equal(snapshot.optionalBytes('*')?.toString(), 'literal star');
  assert.equal(snapshot.optionalBytes('absent.ts'), null);
  assert.throws(() => repositorySnapshot(root, '0'.repeat(40)).optionalBytes('absent.ts'));
});

test('materialization rejects an inherited symlink before writing any proposal bytes', (t) => {
  const { root, commit } = fixture(t);
  const target = join(root, 'target.txt');
  writeFileSync(target, 'preserve');
  symlinkSync('target.txt', join(root, 'value.ts'));
  const base = commit();
  const claim = bindSourceClaim('key', 'run', 'revision', base);
  assert.throws(
    () =>
      brokerSourceProposal(
        root,
        'work',
        {
          schema: SOURCE_TASK_SCHEMA,
          kind: 'source-change',
          objective: 'Edit value',
          writable_paths: ['value.ts'],
        },
        claim,
        {
          schema: SOURCE_PROPOSAL_SCHEMA,
          run_id: 'run',
          claimed_revision: 'revision',
          claimed_source_sha: base,
          files: [
            { path: 'value.ts', content_base64: Buffer.from('replacement').toString('base64') },
          ],
        },
        { remote: 'missing' },
      ),
    /SOURCE_PROPOSAL_MODE_UNSUPPORTED/,
  );
  assert.equal(repositorySnapshot(root, base).bytes('target.txt').toString(), 'preserve');
});
