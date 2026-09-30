import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelativeReferences, restoreRetiredSources } from '../scripts/tcb-retired-source.ts';
import { resolveLocalRuntimeImport } from '../src/analysis/typescript-runtime.ts';

test('retired binding keeps accepted bytes and follows current shared dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'tcb-retired-'));
  try {
    writeFileSync(join(root, 'shared.ts'), 'candidate trust growth');
    const old = new TextEncoder().encode("import './shared.ts';\nexport class Retired {}\n");
    restoreRetiredSources(
      root,
      ['retired.ts', 'shared.ts'],
      ['shared.ts'],
      () => old,
      () => [],
    );
    assert.equal(readFileSync(join(root, 'retired.ts'), 'utf8'), new TextDecoder().decode(old));
    assert.equal(readFileSync(join(root, 'shared.ts'), 'utf8'), 'candidate trust growth');
    assert.equal(resolveLocalRuntimeImport(root, 'retired.ts', './shared.ts'), 'shared.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepted source restoration cannot shadow a candidate replacement module', () => {
  const root = mkdtempSync(join(tmpdir(), 'tcb-shadow-'));
  try {
    mkdirSync(join(root, 'helper'));
    writeFileSync(join(root, 'helper/index.ts'), 'candidate trust growth');
    writeFileSync(join(root, 'caller.ts'), "import './helper';");
    const references = createRelativeReferences(root, ['caller.ts']);
    assert.deepEqual(references('caller.ts'), ['helper', 'helper/index.ts']);
    assert.throws(
      () =>
        restoreRetiredSources(
          root,
          ['helper.ts'],
          ['caller.ts'],
          () => new TextEncoder().encode('baseline'),
          references,
        ),
      /TCB_RETIRED_SOURCE_SHADOWS_CANDIDATE/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const declaration of [
  "import { x } from /* valid comment */ './helper';",
  "export { x } from /* valid comment */ './helper';",
  "import /* valid comment */ './helper';",
  "import(/* valid comment */ './helper');",
  "require(/* valid comment */ './helper');",
  "import x = require(/* valid comment */ './helper');",
  'import(`./helper`);',
]) {
  test(`commented module reference cannot bypass restoration guard: ${declaration}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tcb-comments-'));
    try {
      mkdirSync(join(root, 'helper'));
      writeFileSync(join(root, 'helper/index.ts'), 'export const x = 1;');
      writeFileSync(join(root, 'caller.ts'), declaration);
      const refs = createRelativeReferences(root, ['caller.ts']);
      assert.throws(
        () =>
          restoreRetiredSources(
            root,
            ['helper.ts'],
            ['caller.ts'],
            () => new TextEncoder().encode('export const x = 0;'),
            refs,
          ),
        /TCB_RETIRED_SOURCE_SHADOWS_CANDIDATE/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
