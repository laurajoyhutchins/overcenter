import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  isClassDeclaration,
} from 'typescript';

import {
  canonicalSemanticLoc,
  maximalSemanticLoc,
} from '../src/analysis/tcb-semantic-loc.ts';

function loc(sourceText: string): number {
  const source = createSourceFile(
    'fixture.ts',
    sourceText,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  return canonicalSemanticLoc(source, source);
}

test('TCB semantic LOC is invariant to source layout and comments', () => {
  const normal = `export function trusted(x: number) {
  const y = x + 1;
  if (y > 4) {
    return y;
  }
  return 0;
}
`;
  const minified =
    'export function trusted(x:number){const y=x+1;if(y>4){return y;}return 0;}';
  const reflowed = `export
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
`;
  const commented = `// leading commentary
export function trusted(x: number) {
  /* implementation note */
  const y = x + 1;
  if (y > 4) {
    return y; // success
  }
  return 0;
}
`;

  assert.equal(loc(normal), loc(minified));
  assert.equal(loc(normal), loc(reflowed));
  assert.equal(loc(normal), loc(commented));
});

test('TCB semantic span union counts containing syntax once', () => {
  const source = createSourceFile(
    'fixture.ts',
    'class Trusted { run() { return 1; } }\n',
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  const declaration = source.statements[0];
  assert.ok(declaration && isClassDeclaration(declaration));
  const member = declaration.members[0];
  assert.ok(member);

  const classLoc = canonicalSemanticLoc(declaration, source);
  const memberLoc = canonicalSemanticLoc(member, source);

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
