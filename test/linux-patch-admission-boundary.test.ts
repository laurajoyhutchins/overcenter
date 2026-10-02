import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteFourByFourCalculus } from '../src/authority/sqlite-calculus.ts';
import {
  linuxPatchCoordinate,
  projectLinuxPatchAdmissionBoundary,
  shadowLinuxPatchAdmission,
  type LinuxPatchAdmissionBoundary,
  type LinuxPatchAdmissionEvidence,
} from '../src/integrations/linux-patch-admission.ts';

const durableHead = 'overcenter-linux-shadow-head';
const kernelRevision = '1'.repeat(40);
const baseCommit = '2'.repeat(40);
const externalRevision = '3'.repeat(40);

const accepted: LinuxPatchAdmissionEvidence = {
  schema: 'linux.patch-admission-history',
  schema_version: 1,
  kernel_revision: kernelRevision,
  series: {
    message_id: '<20261001-bpf-example-v3@example.org>',
    version: 3,
    patch_count: 4,
    digest: `sha256:${'a'.repeat(64)}`,
  },
  target: {
    subsystem: 'bpf',
    tree: 'bpf-next',
    branch: 'for-next',
    base_commit: baseCommit,
  },
  authority: {
    maintainer: 'public-maintainer-identity',
    source_digest: `sha256:${'b'.repeat(64)}`,
  },
  evidence_digest: `sha256:${'c'.repeat(64)}`,
  checks: {
    exact_base: true,
    correct_routing: true,
    series_complete: true,
    required_review: true,
    required_tests: true,
  },
  external_prerequisites: [
    {
      id: 'iproute2-uapi-sync',
      project: 'iproute2',
      revision: externalRevision,
      evidence_digest: `sha256:${'d'.repeat(64)}`,
      satisfied: true,
    },
  ],
  maintainer_disposition: 'accepted',
  public_state: 'accepted',
};

function withCalculus(run: (calculus: SqliteFourByFourCalculus) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'linux-patch-admission-'));
  const path = join(root, 'overcenter.sqlite');
  const authority = new DatabaseSync(path);
  authority.exec(`
    CREATE TABLE authority (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      head TEXT,
      sequence INTEGER NOT NULL
    ) STRICT;
  `);
  authority
    .prepare('INSERT INTO authority(singleton, head, sequence) VALUES(1, ?, 1)')
    .run(durableHead);

  const calculus = new SqliteFourByFourCalculus(path);
  try {
    run(calculus);
  } finally {
    calculus.close();
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function shadow(boundary: LinuxPatchAdmissionBoundary) {
  let result: ReturnType<typeof shadowLinuxPatchAdmission> | undefined;
  withCalculus((calculus) => {
    result = shadowLinuxPatchAdmission(calculus, durableHead, boundary);
  });
  assert.ok(result);
  return result;
}

test('explicit public maintainer acceptance plus exact evidence admits integration', () => {
  const boundary = projectLinuxPatchAdmissionBoundary(accepted);
  const decision = shadow(boundary);

  assert.equal(decision.admitted, true);
  assert.equal(decision.agrees_with_public_acceptance, true);
  assert.equal(decision.judgment_required, false);
  assert.equal(decision.exact_permit, true);
  assert.deepEqual(decision.unsupported_requirements, []);
});

test('mechanically complete history without maintainer judgment remains judgment-required', () => {
  const boundary = projectLinuxPatchAdmissionBoundary({
    ...accepted,
    maintainer_disposition: 'unknown',
    public_state: 'queued',
  });
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  assert.equal(decision.judgment_required, true);
  assert.ok(
    decision.unsupported_requirements.includes(boundary.ids.maintainer_acceptance_proposition),
  );
  assert.ok(decision.reasons.includes('MAINTAINER_JUDGMENT_REQUIRED'));
});

test('public accepted state cannot manufacture missing exact-base evidence', () => {
  const boundary = projectLinuxPatchAdmissionBoundary({
    ...accepted,
    checks: { ...accepted.checks, exact_base: false },
    public_state: 'accepted',
  });
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  assert.equal(decision.agrees_with_public_acceptance, false);
  assert.ok(decision.unsupported_requirements.includes(boundary.ids.check_propositions.exact_base));
  assert.ok(decision.reasons.includes('PUBLIC_HISTORY_DISAGREEMENT'));
});

test('explicit maintainer rejection cannot satisfy acceptance', () => {
  const boundary = projectLinuxPatchAdmissionBoundary({
    ...accepted,
    maintainer_disposition: 'rejected',
    public_state: 'rejected',
  });
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  assert.equal(decision.judgment_required, false);
  assert.ok(decision.reasons.includes('MAINTAINER_REJECTED'));
});

test('superseding patch versions and target identities produce new coordinates', () => {
  const original = linuxPatchCoordinate(accepted);

  assert.notEqual(
    linuxPatchCoordinate({
      ...accepted,
      series: { ...accepted.series, version: 4 },
    }),
    original,
  );
  assert.notEqual(
    linuxPatchCoordinate({
      ...accepted,
      target: { ...accepted.target, base_commit: '4'.repeat(40) },
    }),
    original,
  );
  assert.notEqual(
    linuxPatchCoordinate({
      ...accepted,
      target: { ...accepted.target, tree: 'net-next' },
    }),
    original,
  );
  assert.notEqual(
    linuxPatchCoordinate({
      ...accepted,
      authority: {
        ...accepted.authority,
        source_digest: `sha256:${'e'.repeat(64)}`,
      },
    }),
    original,
  );
});

test('support from a superseded series is stale and cannot migrate', () => {
  const prior = projectLinuxPatchAdmissionBoundary(accepted);
  const current = projectLinuxPatchAdmissionBoundary({
    ...accepted,
    series: { ...accepted.series, version: 4 },
  });

  const publicEvidence = current.projection.objects.find((row) => row.role === 'public-evidence');
  assert.ok(publicEvidence);

  current.projection.coordinates.push({
    id: prior.coordinate,
    value: { superseded_by: current.coordinate },
    sources: [],
  });
  publicEvidence.coordinate = prior.coordinate;

  const decision = shadow(current);
  assert.equal(decision.admitted, false);
  assert.ok(decision.stale_supports.length > 0);
  assert.ok(decision.unsupported_requirements.length > 0);
});

test('missing cross-repository prerequisite blocks integration', () => {
  const boundary = projectLinuxPatchAdmissionBoundary({
    ...accepted,
    external_prerequisites: accepted.external_prerequisites.map((item) => ({
      ...item,
      satisfied: false,
    })),
    public_state: 'queued',
  });
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  const prerequisite = boundary.ids.external_propositions['iproute2-uapi-sync'];
  assert.ok(prerequisite);
  assert.ok(decision.unsupported_requirements.includes(prerequisite));
});

test('missing required test evidence remains an ordinary unsupported requirement', () => {
  const boundary = projectLinuxPatchAdmissionBoundary({
    ...accepted,
    checks: { ...accepted.checks, required_tests: false },
    public_state: 'queued',
  });
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  assert.ok(
    decision.unsupported_requirements.includes(boundary.ids.check_propositions.required_tests),
  );
});

test('malformed external evidence fails closed at the boundary', () => {
  const prerequisite = accepted.external_prerequisites[0];
  assert.ok(prerequisite);
  assert.throws(
    () =>
      projectLinuxPatchAdmissionBoundary({
        ...accepted,
        schema_version: 2,
      }),
    /LINUX_PATCH_INVALID:SCHEMA/,
  );
  assert.throws(
    () =>
      projectLinuxPatchAdmissionBoundary({
        ...accepted,
        target: { ...accepted.target, base_commit: 'not-a-commit' },
      }),
    /LINUX_PATCH_INVALID:BASE_COMMIT/,
  );
  assert.throws(
    () =>
      projectLinuxPatchAdmissionBoundary({
        ...accepted,
        external_prerequisites: [prerequisite, prerequisite],
      }),
    /LINUX_PATCH_INVALID:DUPLICATE_EXTERNAL_ID/,
  );
});
