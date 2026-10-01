import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assertExtractedFourByFourContract,
  extractFourByFourSourceContract,
  loadFourByFourSourceContract,
  verifyFourByFourSourceContract,
} from '../scripts/verify-4x4-source-contract.ts';

const ROOT = process.cwd();
const ENGINE = resolve(ROOT, 'src/authority/engine.ts');

function source(): string {
  return readFileSync(ENGINE, 'utf8');
}

test('4x4 contract is bound to the exact production source identity', () => {
  verifyFourByFourSourceContract(ROOT);
});

test('4x4 extractor rejects semantic mutations to admission and release', () => {
  const expected = loadFourByFourSourceContract(ROOT);
  const admissionMutation = source().replace('mutationAdmitted({', 'Boolean({');
  assert.throws(
    () =>
      assertExtractedFourByFourContract(
        extractFourByFourSourceContract(admissionMutation),
        expected,
      ),
    /FOUR_BY_FOUR_SOURCE_CALL_MISSING:admission:mutationAdmitted/,
  );

  const releaseMutation = source().replace(
    "'effect-release.json': release",
    "'unknown-release.json': release",
  );
  assert.throws(
    () =>
      assertExtractedFourByFourContract(
        extractFourByFourSourceContract(releaseMutation),
        expected,
      ),
    /FOUR_BY_FOUR_SOURCE_LITERAL_MISSING:release:effect-release\.json/,
  );
});

test('4x4 extractor fails closed on nested executable control flow', () => {
  const nestedMutation = source().replace(
    '  beginEffect(permit: ExecutionPermit): string {',
    '  beginEffect(permit: ExecutionPermit): string {\n    const hidden = () => true;',
  );
  assert.throws(
    () => extractFourByFourSourceContract(nestedMutation),
    /FOUR_BY_FOUR_SOURCE_UNSUPPORTED_NESTED_EXECUTABLE/,
  );
});
