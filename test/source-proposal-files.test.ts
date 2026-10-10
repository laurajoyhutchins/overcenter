import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSourceAssignment, validateSourceProposal } from '../src/source/source-obligation.ts';

test('hosted proposal intake binds file bytes to its supplied assignment and rejects foreign writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'source-proposal-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assignment = buildSourceAssignment(
    'fixture',
    {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'Fixture',
      writable_paths: ['value.py'],
    },
    {
      obligation_key: 'fixture',
      run_id: 'fixture-run',
      claimed_revision: 'fixture-authority',
      source_sha: 'a'.repeat(40),
    },
  );
  const assignmentPath = join(root, 'assignment.json');
  const output = join(root, 'proposal.json');
  writeFileSync(assignmentPath, JSON.stringify(assignment));
  const run = (files: unknown) =>
    spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        new URL('../src/cli/source-proposal-files.ts', import.meta.url).pathname,
        '--assignment',
        assignmentPath,
        '--output',
        output,
      ],
      {
        env: {
          ...process.env,
          SOURCE_PROPOSAL_FILES_BASE64: Buffer.from(JSON.stringify(files)).toString('base64'),
        },
        encoding: 'utf8',
      },
    );
  assert.equal(
    run([{ path: 'value.py', content_base64: Buffer.from('value=42\n').toString('base64') }])
      .status,
    0,
  );
  const proposal = validateSourceProposal(
    JSON.parse(readFileSync(output, 'utf8')),
    assignment.task,
    assignment.claim,
  );
  assert.equal(proposal.run_id, assignment.claim.run_id);
  assert.equal(proposal.claimed_source_sha, assignment.claim.source_sha);
  assert.notEqual(
    run([{ path: '.github/escape.yml', content_base64: Buffer.from('escape').toString('base64') }])
      .status,
    0,
  );
});
