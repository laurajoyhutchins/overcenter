import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGcpBuildImage,
  observeCertifiedGcpArtifactRepository,
  observeCertifiedGcpBuild,
  observeCertifiedGcpStorageObject,
} from '../src/providers/gcp/artifact-observations.ts';
import type { GcpJsonGet } from '../src/providers/gcp/rest.ts';

const build = { project: 'demo-project', location: 'us-west1', build: 'build-123' };
const imageDigest = 'sha256:' + 'a'.repeat(64);

test('Cloud Build read binds project, location and build ID with terminal-image settlement', () => {
  const requests: Parameters<GcpJsonGet>[1][] = [];
  const body = {
    id: 'build-123',
    projectId: 'demo-project',
    status: 'SUCCESS',
    results: { images: [{ name: 'repo/image', digest: imageDigest }] },
    secretEnv: 'not-certified',
  };
  const result = observeCertifiedGcpBuild('token', build, {
    get: (_token, request) => {
      requests.push(request);
      return body;
    },
  });
  assert.equal(result.state, 'observed');
  assert.deepEqual(
    requests.map((r) => [r.authority_host, r.path]),
    [
      [
        'cloudbuild.googleapis.com',
        '/v1/projects/demo-project/locations/us-west1/builds/build-123',
      ],
    ],
  );
  assert.equal(JSON.stringify(result).includes('secretEnv'), false);
  assert.equal(assessGcpBuildImage(result, { name: 'repo/image', digest: imageDigest }), 'settled');
  assert.equal(
    assessGcpBuildImage(result, { name: 'repo/image', digest: 'sha256:' + 'b'.repeat(64) }),
    'hold',
  );
  assert.equal(
    assessGcpBuildImage(
      observeCertifiedGcpBuild('token', build, {
        get: () => ({ ...body, status: 'WORKING' }),
      }),
      { name: 'repo/image', digest: imageDigest },
    ),
    'hold',
  );
});

test('Cloud Storage metadata observation binds bucket/name/generation and CRC32C shape', () => {
  const coordinate = { bucket: 'demo-bucket', object: 'subfolder/evidence.json' };
  const paths: string[] = [];
  const get: GcpJsonGet = (_token, request) => {
    paths.push(request.path);
    return {
      bucket: 'demo-bucket',
      name: 'subfolder/evidence.json',
      generation: '123456789',
      crc32c: 'ImIEBA==',
      size: '120',
      mediaLink: 'uncertified',
    };
  };
  const good = observeCertifiedGcpStorageObject('token', coordinate, { get });
  assert.equal(good.state, 'observed');
  assert.deepEqual(paths, ['/storage/v1/b/demo-bucket/o/subfolder%2Fevidence.json']);
  if (good.state === 'observed') assert.equal(good.value.generation, '123456789');
  for (const override of [
    { generation: '0' },
    { bucket: 'other' },
    { crc32c: 'bad' },
    { name: 'other/object' },
  ]) {
    const invalid = observeCertifiedGcpStorageObject('token', coordinate, {
      get: () => ({
        bucket: coordinate.bucket,
        name: coordinate.object,
        generation: '123',
        crc32c: 'ImIEBA==',
        size: '10',
        ...override,
      }),
    });
    assert.equal(invalid.state, 'indeterminate');
  }
});

test('Artifact Registry repository rejects wrong project and format', () => {
  const coordinate = { project: 'demo-project', location: 'us-west1', repository: 'images' };
  const body = {
    name: 'projects/demo-project/locations/us-west1/repositories/images',
    format: 'DOCKER',
  };
  const good = observeCertifiedGcpArtifactRepository('token', coordinate, { get: () => body });
  assert.equal(good.state, 'observed');
  const bad = observeCertifiedGcpArtifactRepository('token', coordinate, {
    get: () => ({ ...body, name: 'projects/other/locations/us-west1/repositories/images' }),
  });
  assert.equal(bad.state, 'indeterminate');
});

test('artifact reads fail closed on 403 and invalid project coordinate', () => {
  const forbidden = observeCertifiedGcpBuild('token', build, {
    get: () => {
      throw new Error('HTTP 403');
    },
  });
  assert.deepEqual(forbidden, { state: 'indeterminate', observation_error: 'HTTP 403' });
  let calls = 0;
  const malformed = observeCertifiedGcpBuild(
    'token',
    { ...build, location: 'us-west1/other' },
    {
      get: () => {
        calls++;
        return {};
      },
    },
  );
  assert.equal(malformed.state, 'indeterminate');
  assert.equal(calls, 0);
});
