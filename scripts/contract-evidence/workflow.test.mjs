import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('contract evidence workflow derives and attests exact merge-candidate evidence', async () => {
  const workflow = await readFile('.github/workflows/contract-evidence.yml', 'utf8');

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{ github\.head_ref \}\}/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(workflow, /BASE_SHA=\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /HEAD_SHA=\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);

  assert.match(workflow, /candidate_postgres:[\s\S]*- 5432:5432/);
  assert.match(workflow, /base_postgres:[\s\S]*- 5433:5432/);
  assert.match(workflow, /git worktree add --detach "\$BASE_ROOT" "\$BASE_SHA"/);
  assert.match(workflow, /PGPORT=5433 node scripts\/contract-evidence\/cli\.mjs generate/);
  assert.match(workflow, /--catalog "\$BASE_EVIDENCE\/generated\/contracts\/catalog\.json"/);
  assert.match(workflow, /--catalog "\$CANDIDATE_EVIDENCE\/generated\/contracts\/catalog\.json"/);
  assert.match(workflow, /cli\.mjs compare[\s\S]*--base-catalog "\$BASE_EVIDENCE\/generated\/contracts\/catalog\.json"[\s\S]*--head-catalog "\$CANDIDATE_EVIDENCE\/generated\/contracts\/catalog\.json"/);

  assert.match(workflow, /overcenter-contract-evidence-attestation-v1/);
  assert.match(workflow, /candidate_sha:candidateSha/);
  assert.match(workflow, /head_sha:headSha/);
  assert.match(workflow, /base_sha:baseSha/);
  assert.match(workflow, /verifier_digest:`sha256:\$\{verifierDigest\}`/);
  assert.match(workflow, /evidence_digest:`sha256:\$\{evidenceDigest\}`/);
  assert.match(workflow, /base_evidence_digest:`sha256:\$\{baseEvidenceDigest\}`/);
  assert.match(workflow, /predicate:'no-new-unclassified-contract-identities'/);
  assert.match(workflow, /result:'pass'/);
  assert.match(workflow, /actions\/upload-artifact@v4/);

  assert.doesNotMatch(workflow, /Verify committed generated evidence/);
  assert.doesNotMatch(workflow, /cli\.mjs check/);
  assert.doesNotMatch(workflow, /git show "\$MERGE_BASE:generated\/contracts\/catalog\.json"/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /git push/);
});
