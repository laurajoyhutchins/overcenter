import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('legacy lifecycle-to-lane projection is isolated behind compatibility code', async () => {
  const [lifecycle, compatibility, leases] = await Promise.all([
    read('lib/work-lifecycle.js'),
    read('lib/legacy-lane-compatibility.js'),
    read('lib/work-leases.js'),
  ]);

  assert.doesNotMatch(lifecycle, /LEGACY_LANE_BY_STAGE|STAGE_BY_LEGACY_LANE|legacyProjectionForStage/,
    'canonical lifecycle module still owns legacy lane projection');
  assert.match(compatibility, /LEGACY_LANE_BY_STAGE/);
  assert.match(compatibility, /STAGE_BY_LEGACY_LANE/);
  assert.match(compatibility, /legacyProjectionForStage/);
  assert.match(leases, /from ['"]\.\/legacy-lane-compatibility\.js['"]/,
    'legacy work settlement must consume the explicit compatibility adapter');
});

test('graph-native runtime does not import legacy lane compatibility', async () => {
  const graphNativePaths = [
    'lib/project-graph.js',
    'lib/project-transition-leases.js',
    'lib/orchestration-advance.js',
    'lib/orchestration-drive.js',
    'lib/orchestration-run-target-runtime.js',
  ];
  for (const path of graphNativePaths) {
    const source = await read(path);
    assert.doesNotMatch(source, /legacy-lane-compatibility|LEGACY_LANE_BY_STAGE|STAGE_BY_LEGACY_LANE/,
      `${path} depends on legacy lifecycle-to-lane projection`);
  }
});