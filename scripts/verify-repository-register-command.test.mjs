import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_COMMANDS } from '../lib/command-response.js';

test('repository registration is an admitted canonical command', () => {
  assert.equal(CANONICAL_COMMANDS.includes('portfolio.repository_register'), true);
});