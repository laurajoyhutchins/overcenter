import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dashboard = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../pages/dashboard.js', import.meta.url), 'utf8');

test('operator dashboard presents authoritative project transitions before kernel choreography', () => {
  assert.match(page, /Project transitions/i, 'dashboard heading is not transition-first');
  assert.doesNotMatch(page, /Run\s*→\s*claim\s*→\s*work\s*→\s*effects\s*→\s*settle\s*→\s*finish/i, 'legacy kernel choreography remains the primary heading');
  assert.match(dashboard, /project_transitions/, 'dashboard does not consume authoritative project transition status');
  assert.doesNotMatch(dashboard, /WORK_LIFECYCLE/, 'dashboard still hardcodes the legacy stage-to-lane lifecycle');
  assert.doesNotMatch(dashboard, /lane:(enable|source-implementation|repo-implementation|integration|verification)/, 'dashboard still presents legacy lanes as product semantics');
});

test('operator dashboard degrades truthfully when project graph authority is unavailable', () => {
  assert.match(dashboard, /project[^\n]{0,80}unavailable|authority[^\n]{0,80}unavailable/i, 'dashboard lacks an explicit unavailable project-authority state');
});