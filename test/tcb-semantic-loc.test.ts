import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isClassDeclaration } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

import { logicalSemanticLoc, maximalSemanticLoc } from '../src/analysis/tcb-semantic-loc.ts';

function layoutFixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tcb-layout-'));
  const sources = {
    normal: `export function trusted(x: number) {
  const y = x + 1;
  if (y > 4) {
    return y;
  }
  return 0;
}
`,
    minified: 'export function trusted(x:number){const y=x+1;if(y>4){return y;}return 0;}',
    reflowed: `export
function
trusted(
  x:
    number,
)
{
  const
    y
      =
        x
        +
        1;
  if (
    y
      >
        4
  )
  {
    return y;
  }
  return 0;
}
`,
    commented: `// leading commentary
export function trusted(x: number) {
  /* implementation note */
  const y = x + 1;
  if (y > 4) {
    return y; // success
  }
  return 0;
}
`,
    nested: 'class Trusted { run() { return 1; } }\n',
  } as const;

  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          target: 'ES2023',
        },
        files: Object.keys(sources).map((name) => `${name}.ts`),
      },
      null,
      2,
    )}\n`,
  );
  for (const [name, source] of Object.entries(sources)) {
    writeFileSync(join(root, `${name}.ts`), source);
  }

  const api = new API({ cwd: root });
  const snapshot = api.updateSnapshot({ openProject: 'tsconfig.json' });
  t.after(() => {
    snapshot.dispose();
    api.close();
    rmSync(root, { recursive: true, force: true });
  });

  const source = (name: keyof typeof sources) => {
    const path = join(root, `${name}.ts`);
    const project = snapshot.getDefaultProjectForFile(path);
    const file = project?.program.getSourceFile(path);
    if (!file) throw new Error(`TCB_LAYOUT_FIXTURE_SOURCE_MISSING:${name}`);
    return file;
  };

  return { source };
}

test('TCB semantic LOC is invariant to source layout and comments', (t) => {
  const fixture = layoutFixture(t);
  const expected = logicalSemanticLoc(fixture.source('normal'));

  assert.equal(logicalSemanticLoc(fixture.source('minified')), expected);
  assert.equal(logicalSemanticLoc(fixture.source('reflowed')), expected);
  assert.equal(logicalSemanticLoc(fixture.source('commented')), expected);
});

test('TCB semantic span union counts containing syntax once', (t) => {
  const fixture = layoutFixture(t);
  const source = fixture.source('nested');
  const declaration = source.statements[0];
  assert.ok(declaration && isClassDeclaration(declaration));
  const member = declaration.members[0];
  assert.ok(member);

  const classLoc = logicalSemanticLoc(declaration);
  const memberLoc = logicalSemanticLoc(member);

  assert.equal(
    maximalSemanticLoc([
      {
        start_offset: declaration.getStart(source),
        end_offset: declaration.getEnd(),
        semantic_loc: classLoc,
      },
      {
        start_offset: member.getStart(source),
        end_offset: member.getEnd(),
        semantic_loc: memberLoc,
      },
    ]),
    classLoc,
  );
});
