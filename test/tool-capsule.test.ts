import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  TOOL_CAPSULE_REQUEST_SCHEMA,
  buildToolCapsuleManifest,
  renderHashedRequirements,
  validateToolCapsuleRequest,
  verifyToolCapsule,
} from '../src/transport/tool-capsule.ts';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function request(): unknown {
  return {
    schema: TOOL_CAPSULE_REQUEST_SCHEMA,
    source: {
      repository: 'laurajoyhutchins/arcata',
      revision: '1'.repeat(40),
      lock_blob_sha: '2'.repeat(40),
    },
    target: { python_version: '3.13', platform: 'linux-x86-64' },
    packages: [
      { name: 'ruff', version: '0.13.2', hashes: [hashB, hashA] },
      { name: 'mypy', version: '1.18.2', hashes: [hashA] },
    ],
  };
}

test('request validation canonicalizes package and hash ordering', () => {
  const parsed = validateToolCapsuleRequest(request());
  assert.deepEqual(
    parsed.packages.map((pkg) => pkg.name),
    ['mypy', 'ruff'],
  );
  assert.deepEqual(parsed.packages[1]?.hashes, [hashA, hashB]);
});

test('request rejects unsafe names, duplicate packages, and invalid source bindings', () => {
  const unsafe = structuredClone(request()) as Record<string, unknown>;
  unsafe.packages = [{ name: 'ruff;touch', version: '0.13.2', hashes: [hashA] }];
  assert.throws(() => validateToolCapsuleRequest(unsafe), /TOOL_CAPSULE_PACKAGE_INVALID/);

  const duplicate = structuredClone(request()) as Record<string, unknown>;
  duplicate.packages = [
    { name: 'ruff', version: '0.13.2', hashes: [hashA] },
    { name: 'ruff', version: '0.13.2', hashes: [hashB] },
  ];
  assert.throws(
    () => validateToolCapsuleRequest(duplicate),
    /TOOL_CAPSULE_PACKAGE_NAME_INVALID/,
  );

  const wrongRevision = structuredClone(request()) as Record<string, unknown>;
  wrongRevision.source = {
    repository: 'laurajoyhutchins/arcata',
    revision: '../main',
    lock_blob_sha: '2'.repeat(40),
  };
  assert.throws(() => validateToolCapsuleRequest(wrongRevision), /TOOL_CAPSULE_SOURCE_INVALID/);
});

test('hashed requirements are deterministic and contain no dependency resolver freedom', () => {
  const requirements = renderHashedRequirements(request());
  assert.equal(
    requirements,
    `mypy==1.18.2 \\\n    --hash=sha256:${hashA}\nruff==0.13.2 \\\n    --hash=sha256:${hashA} \\\n    --hash=sha256:${hashB}\n`,
  );
});

test('manifest binds exact request bytes and exact wheelhouse membership', () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-capsule-'));
  try {
    writeFileSync(join(root, 'mypy-1.18.2-py3-none-any.whl'), 'mypy');
    writeFileSync(join(root, 'ruff-0.13.2-py3-none-any.whl'), 'ruff');
    const requestBytes = Buffer.from(`${JSON.stringify(request())}\n`);
    const manifest = buildToolCapsuleManifest(requestBytes, root);
    assert.equal(manifest.files.length, 2);
    assert.equal(verifyToolCapsule(requestBytes, manifest, root), true);

    writeFileSync(join(root, 'ruff-0.13.2-py3-none-any.whl'), 'altered');
    assert.throws(
      () => verifyToolCapsule(requestBytes, manifest, root),
      /TOOL_CAPSULE_MANIFEST_MISMATCH/,
    );

    writeFileSync(join(root, 'extra-1-py3-none-any.whl'), 'extra');
    assert.throws(
      () => buildToolCapsuleManifest(requestBytes, root),
      /TOOL_CAPSULE_WHEEL_COUNT_MISMATCH/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest rejects a request with different bytes even when parsed meaning is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-capsule-'));
  try {
    writeFileSync(join(root, 'mypy-1.18.2-py3-none-any.whl'), 'mypy');
    writeFileSync(join(root, 'ruff-0.13.2-py3-none-any.whl'), 'ruff');
    const compact = Buffer.from(JSON.stringify(request()));
    const pretty = Buffer.from(`${JSON.stringify(request(), null, 2)}\n`);
    const manifest = buildToolCapsuleManifest(compact, root);
    assert.notEqual(readFileSync(join(root, 'mypy-1.18.2-py3-none-any.whl')).length, 0);
    assert.throws(
      () => verifyToolCapsule(pretty, manifest, root),
      /TOOL_CAPSULE_MANIFEST_MISMATCH/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
