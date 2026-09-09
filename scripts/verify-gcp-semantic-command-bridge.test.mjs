import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const api = await readFile(new URL('api/gcp-semantic-command-dispatch.js', root), 'utf8');
const workflow = await readFile(new URL('.github/workflows/gcp-semantic-command.yml', root), 'utf8');

test('bounded GCP broker admits lease-scoped GitHub mutations without broadening source authority', () => {
  assert.match(api, /LEASE_MUTATION_COMMANDS = new Set\(\['github\.apply_changeset', 'github\.apply_text_replacements'\]\)/);
  assert.match(api, /COMMAND_INPUT_CHUNK_SIZE = 4000/);
  assert.match(api, /MAX_COMMAND_INPUT_CHUNKS = 6/);
  assert.match(api, /MAX_COMMAND_INPUT_CHARS = COMMAND_INPUT_CHUNK_SIZE \* MAX_COMMAND_INPUT_CHUNKS/);
  assert.match(api, /workflowInputs\[`command_input_\$\{index\}`\] = chunk/);
  assert.match(api, /PROJECT_COMMANDS\.has\(command\)/);
  assert.match(api, /project commands do not accept input/);
  assert.match(api, /lease-scoped GitHub mutations do not accept project\.advance continuation fields/);
  assert.doesNotMatch(api, /production\.promote|production\.reconcile|work\.settle/);
});

test('GCP workflow preserves exact-revision and fixed-project fences while reassembling bounded chunks', () => {
  assert.match(workflow, /command_input_0:/);
  assert.match(workflow, /command_input_5:/);
  assert.match(workflow, /command_input_json="\$\{COMMAND_INPUT_0\}\$\{COMMAND_INPUT_1\}\$\{COMMAND_INPUT_2\}\$\{COMMAND_INPUT_3\}\$\{COMMAND_INPUT_4\}\$\{COMMAND_INPUT_5\}"/);
  assert.match(workflow, /test "\$\(git ls-remote origin refs\/heads\/dev \| cut -f1\)" = "\$EXPECTED_HEAD"/);
  assert.match(workflow, /test "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$EXPECTED_HEAD"/);
  assert.match(workflow, /test "\$PROJECT_REF" = 'github:laurajoyhutchins\/overcenter'/);
  assert.match(workflow, /project\.inspect\|project\.advance\|github\.apply_changeset\|github\.apply_text_replacements/);
  assert.match(workflow, /jq -e 'type == "object" and \(\.lease_ref \| type == "string" and length > 0\)'/);
  assert.match(workflow, /github\.apply_changeset\|github\.apply_text_replacements\)\n\s+input="\$command_input_json"/);
  assert.match(workflow, /x-overcenter-authority-mode: authoritative/);
  assert.match(workflow, /x-overcenter-request-id: \$REQUEST_ID/);
});
