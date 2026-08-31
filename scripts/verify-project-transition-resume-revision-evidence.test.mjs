import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendProjectGraphRevisionResumeEvidence, projectGraphRevisionResumeEvidence } from '../lib/project-graph-revision-resume-evidence.js';

test('project graph revision settlement evidence is projected compactly into resume evidence', () => {
  const change = {
    schema:'project-graph-revision-change-v1',
    previous_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' },
    current_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'2'.repeat(40), derivation:'overcenter-project-graph-v1' },
  };
  const evidence = projectGraphRevisionResumeEvidence({ graph_revision_change:change });
  assert.equal(evidence?.kind, 'project_graph_revision_change');
  assert.deepEqual(evidence?.graph_revision_change, change);
  const packet = appendProjectGraphRevisionResumeEvidence({ evidence:[] }, evidence);
  assert.deepEqual(packet.evidence, [evidence]);
  assert.equal(projectGraphRevisionResumeEvidence({ graph_revision_change:{ schema:'unknown' } }), null);
});

test('target resume runtime reads only project-transition settlement evidence and composes the projector', async () => {
  const source = await readFile(new URL('../lib/orchestration-run-target-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /claim_receipt->>'subject' = 'project_transition'/);
  assert.match(source, /projectGraphRevisionResumeEvidence\(result\?\.rows\?\.\[0\]\?\.settle_receipt\)/);
  assert.match(source, /appendProjectGraphRevisionResumeEvidence\(basePacket, graphRevisionEvidence\)/);
});