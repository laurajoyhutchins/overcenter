import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('repository registration is an admitted canonical command', async () => {
  const commands = await readFile('lib/command-response.js', 'utf8');
  assert.match(commands, /['"]portfolio\.repository_register['"]/);
});