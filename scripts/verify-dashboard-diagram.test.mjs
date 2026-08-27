import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('pages/dashboard.js', 'utf8');
const client = readFileSync('public/dashboard.js', 'utf8');
const css = readFileSync('public/dashboard.css', 'utf8');

test('dashboard is a semantic execution-path diagram rather than a KPI card grid', () => {
  assert.match(page, /id="execution-path"/);
  assert.match(page, /id="exceptions"/);
  assert.doesNotMatch(page, /id="metrics"/);
  assert.doesNotMatch(page, /id="commands"/);

  assert.match(client, /FLOW_STAGES/);
  assert.match(client, /renderExecutionPath/);
  assert.match(client, /commandTraffic/);
  assert.match(client, /oldest_refs/);
  assert.doesNotMatch(client, /function metric\(/);

  assert.match(css, /\.execution-diagram/);
  assert.match(css, /\.flow-node/);
  assert.match(css, /\.flow-edge/);
  assert.match(css, /@media \(max-width: 820px\)/);
});

test('diagram exposes real orchestration operations and failure semantics', () => {
  for (const command of [
    'orchestration.start',
    'work.claim',
    'work.checkpoint',
    'work.heartbeat',
    'github.apply_changeset',
    'portfolio.reconcile_work_surface',
    'work.settle',
    'orchestration.finish',
  ]) assert.match(client, new RegExp(command.replaceAll('.', '\\.')));

  for (const condition of [
    'overdue_active_runs',
    'expired_active_slots',
    'leases_stuck_claiming',
    'leases_stuck_settling',
    'journal_stuck_running',
    'journal_indeterminate',
    'github_changesets_processing',
    'github_changesets_prepared',
    'portfolio_reconcile_processing',
    'portfolio_reconcile_indeterminate',
  ]) assert.match(client, new RegExp(condition));
});

test('schematic control panel fits desktop and keeps mobile connectors compact', () => {
  const desktop = css.split('@media (max-width: 820px)')[0];
  assert.doesNotMatch(desktop, /\.flow-sequence[\s\S]*?overflow-x:\s*auto/);
  assert.match(desktop, /\.flow-edge\s*\{[\s\S]*?min-width:\s*0/);

  const mobile = css.split('@media (max-width: 820px)')[1] || '';
  const match = mobile.match(/\.flow-edge\s*\{[\s\S]*?min-height:\s*(\d+)px/);
  assert.ok(match, 'mobile flow edge needs an explicit compact min-height');
  assert.ok(Number(match[1]) <= 64, `expected mobile connector <=64px, got ${match[1]}px`);
});
