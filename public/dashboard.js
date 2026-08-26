const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

const FLOW_STAGES = Object.freeze([
  { id: 'run', label: 'RUN', detail: 'Durable orchestration run', conditions: ['overdue_active_runs'] },
  { id: 'claim', label: 'CLAIM', detail: 'Exclusive work ownership', conditions: ['expired_active_slots', 'leases_stuck_claiming'] },
  { id: 'work', label: 'WORK', detail: 'Bounded productive responsibility', conditions: [] },
  { id: 'effects', label: 'EFFECTS', detail: 'Durable external mutations', conditions: ['github_changesets_processing', 'github_changesets_prepared', 'portfolio_reconcile_processing', 'portfolio_reconcile_indeterminate'] },
  { id: 'settle', label: 'SETTLE', detail: 'Truthful lease disposition', conditions: ['leases_stuck_settling'] },
  { id: 'finish', label: 'FINISH', detail: 'Close durable run', conditions: [] },
]);

const WORK_LIFECYCLE = Object.freeze([
  ['ENABLE', 'lane:enable'],
  ['ACQUIRE', 'lane:source-implementation'],
  ['EXECUTE', 'lane:repo-implementation'],
  ['COMMIT', 'lane:integration'],
  ['CONFIRM', 'lane:verification'],
]);

const EDGE_COMMANDS = Object.freeze([
  { from: 'run', to: 'claim', label: 'select + claim', commands: ['orchestration.horizon_checkpoint', 'orchestration.horizon_resolve', 'work.claim'] },
  { from: 'claim', to: 'work', label: 'lease active', commands: ['work.checkpoint', 'work.heartbeat'] },
  { from: 'work', to: 'effects', label: 'produce evidence', commands: ['github.apply_changeset', 'portfolio.reconcile_work_surface'] },
  { from: 'effects', to: 'settle', label: 'integrate / project', commands: ['github.pull_request.create', 'github.pull_request.mark_ready', 'github.review_packet', 'github.integration.reconcile', 'portfolio.repository_register'] },
  { from: 'settle', to: 'finish', label: 'settle + finish', commands: ['work.settle', 'orchestration.finish'] },
]);

const START_COMMANDS = Object.freeze(['orchestration.start', 'orchestration.maintain']);

const CONDITION_LABELS = Object.freeze({
  overdue_active_runs: 'overdue active runs',
  expired_active_slots: 'expired active slots',
  leases_stuck_claiming: 'leases stuck claiming',
  leases_stuck_settling: 'leases stuck settling',
  journal_stuck_running: 'journal entries stuck running',
  journal_indeterminate: 'indeterminate journal entries',
  github_changesets_processing: 'GitHub changesets stuck processing',
  github_changesets_prepared: 'GitHub changesets stuck prepared',
  portfolio_reconcile_processing: 'portfolio reconciles stuck processing',
  portfolio_reconcile_indeterminate: 'indeterminate portfolio reconciles',
});

function countCondition(data, key) {
  return Number(data?.conditions?.[key]?.count || 0);
}

function commandTraffic(data, commands) {
  const wanted = new Set(commands);
  const totals = { succeeded: 0, rejected: 0, failed: 0, running: 0, other: 0 };
  for (const row of data.recent_command_outcomes || []) {
    if (!wanted.has(row.command)) continue;
    const outcome = Object.prototype.hasOwnProperty.call(totals, row.outcome) ? row.outcome : 'other';
    totals[outcome] += Number(row.count || 0);
  }
  return totals;
}

function trafficTotal(traffic) {
  return Object.values(traffic).reduce((sum, value) => sum + Number(value || 0), 0);
}

function trafficMarkup(data, commands, compact = false) {
  const traffic = commandTraffic(data, commands);
  const parts = [
    ['ok', traffic.succeeded],
    ['reject', traffic.rejected],
    ['fail', traffic.failed],
    ['running', traffic.running],
  ].filter(([, count]) => count > 0);
  if (!parts.length) return `<span class="traffic-empty">no traffic</span>`;
  return `<span class="traffic ${compact ? 'traffic-compact' : ''}" aria-label="${trafficTotal(traffic)} command outcomes">${parts.map(([kind, count]) =>
    `<span class="traffic-part traffic-${kind}"><strong>${count}</strong> ${kind}</span>`
  ).join('')}</span>`;
}

function stageFaults(data, stage) {
  return stage.conditions.reduce((sum, key) => sum + countCondition(data, key), 0);
}

function nodeMarkup(data, stage) {
  const faults = stageFaults(data, stage);
  const conditionRows = stage.conditions.map((key) => {
    const count = countCondition(data, key);
    return `<li class="${count ? 'fault-present' : ''}"><span>${esc(CONDITION_LABELS[key] || key)}</span><strong>${count}</strong></li>`;
  }).join('');
  const workLifecycle = stage.id === 'work' ? `
    <ol class="lifecycle-strip" aria-label="Productive work lifecycle">
      ${WORK_LIFECYCLE.map(([name, lane]) => `<li><strong>${name}</strong><span>${esc(lane.replace('lane:', ''))}</span></li>`).join('')}
    </ol>` : '';
  return `
    <article class="flow-node ${faults ? 'flow-node-fault' : 'flow-node-clear'}" data-stage="${stage.id}">
      <div class="node-head">
        <div><span class="node-kicker">${esc(stage.id)}</span><h3>${esc(stage.label)}</h3></div>
        <span class="fault-count" aria-label="${faults} current faults">${faults}</span>
      </div>
      <p>${esc(stage.detail)}</p>
      ${conditionRows ? `<ul class="condition-mini">${conditionRows}</ul>` : ''}
      ${workLifecycle}
    </article>`;
}

function edgeMarkup(data, edge) {
  return `
    <div class="flow-edge" data-from="${edge.from}" data-to="${edge.to}">
      <div class="edge-line" aria-hidden="true"><span></span></div>
      <div class="edge-evidence">
        <strong>${esc(edge.label)}</strong>
        ${trafficMarkup(data, edge.commands)}
        <small>${edge.commands.map(esc).join(' · ')}</small>
      </div>
    </div>`;
}

function journalMarkup(data) {
  const running = data.conditions?.journal_stuck_running || {};
  const indeterminate = data.conditions?.journal_indeterminate || {};
  const faults = Number(running.count || 0) + Number(indeterminate.count || 0);
  const refs = [
    ...(running.oldest_refs || []).map((row) => ({ ...row, journal_state: 'stuck running' })),
    ...(indeterminate.oldest_refs || []).map((row) => ({ ...row, journal_state: 'indeterminate' })),
  ];
  return `
    <aside class="journal-backplane ${faults ? 'journal-fault' : ''}" aria-label="Command journal">
      <div class="journal-title">
        <div><span class="node-kicker">BACKPLANE</span><h3>COMMAND JOURNAL</h3></div>
        <span class="fault-count" aria-label="${faults} journal faults">${faults}</span>
      </div>
      <p>Every semantic command crosses the durable journal. Current journal faults attach to the command that owns them.</p>
      ${refs.length ? `<div class="journal-refs">${refs.map((row) => `
        <div class="journal-ref">
          <strong>${esc(row.command || 'unknown command')}</strong>
          <span>${esc(row.journal_state)}</span>
          <code>${esc(row.invocation_id || row.run_id || 'unknown ref')}</code>
        </div>`).join('')}</div>` : '<div class="journal-clear">No unresolved journal entries.</div>'}
    </aside>`;
}

function startRailMarkup(data) {
  return `
    <div class="start-rail" aria-label="Run admission traffic">
      <span>run admission / maintenance</span>
      ${trafficMarkup(data, START_COMMANDS, true)}
      <small>${START_COMMANDS.map(esc).join(' · ')}</small>
    </div>`;
}

function renderExecutionPath(data) {
  const sequence = [];
  FLOW_STAGES.forEach((stage, index) => {
    sequence.push(nodeMarkup(data, stage));
    if (index < EDGE_COMMANDS.length) sequence.push(edgeMarkup(data, EDGE_COMMANDS[index]));
  });
  $('execution-path').innerHTML = `
    ${startRailMarkup(data)}
    <div class="flow-sequence">${sequence.join('')}</div>
    ${journalMarkup(data)}
    <div class="diagram-legend">
      <span><i class="legend-dot legend-clear"></i> node count = unresolved conditions now</span>
      <span><i class="legend-dot legend-fault"></i> attention required</span>
      <span>edge counters = command outcomes in ${Number(data.observed_window_hours || 24)}h</span>
    </div>`;
}

function formatRef(row) {
  const preferred = [
    ['command', row.command],
    ['work', row.work_ref],
    ['repo', row.repo],
    ['run', row.run_id],
    ['lease', row.lease_id],
    ['invocation', row.invocation_id],
    ['branch', row.branch],
    ['phase', row.phase],
    ['commit', row.commit_sha],
  ].filter(([, value]) => value != null && value !== '');
  return preferred.map(([label, value]) => `<span><b>${esc(label)}</b> ${esc(value)}</span>`).join('');
}

function renderExceptions(data) {
  const entries = Object.entries(data.conditions || {})
    .filter(([, value]) => Number(value?.count || 0) > 0);
  $('exceptions').innerHTML = entries.length ? entries.map(([key, value]) => `
    <article class="evidence-row">
      <div class="evidence-summary">
        <strong>${esc(CONDITION_LABELS[key] || key.replaceAll('_', ' '))}</strong>
        <span>${Number(value.count || 0)} unresolved</span>
        ${value.oldest_at ? `<small>oldest ${esc(value.oldest_at)}</small>` : ''}
      </div>
      <div class="ref-list">
        ${(value.oldest_refs || []).length ? value.oldest_refs.map((row) => `<div class="ref-row">${formatRef(row)}</div>`).join('') : '<span class="muted">No exact refs returned.</span>'}
      </div>
    </article>`).join('') : '<div class="empty-state">No stranded orchestration state is currently reported.</div>';
}

function signalRow(title, count, detail, meta = '') {
  return `<div class="signal-row"><div><strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</div><div class="signal-count">${Number(count || 0)}</div>${meta ? `<small>${esc(meta)}</small>` : ''}</div>`;
}

function renderSignals(data) {
  const rejections = data.recent_expected_rejections || [];
  $('rejections').innerHTML = rejections.length ? rejections.slice(0, 12).map((row) =>
    signalRow(row.error_code || 'rejected', row.count, row.command, row.newest_at ? `latest ${row.newest_at}` : '')
  ).join('') : '<div class="empty-state">No expected rejections in the observed window.</div>';

  const errors = data.recent_error_codes || [];
  $('errors').innerHTML = errors.length ? errors.slice(0, 12).map((row) =>
    signalRow(row.error_code, row.count, '', row.newest_at ? `latest ${row.newest_at}` : '')
  ).join('') : '<div class="empty-state">No error codes in the observed window.</div>';
}

async function load() {
  $('health').textContent = 'Refreshing…';
  try {
    const response = await fetch('/api/orchestration/status', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: '{}',
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);

    const conditions = Object.values(data.conditions || {});
    const stranded = conditions.reduce((sum, value) => sum + Number(value?.count || 0), 0);
    $('health').textContent = data.healthy ? 'Healthy · no stranded state' : `${stranded} current exception${stranded === 1 ? '' : 's'}`;
    $('window').textContent = `${Number(data.observed_window_hours || 24)}h command window · ${Number(data.stuck_threshold_minutes || 5)}m stuck threshold`;

    renderExecutionPath(data);
    renderExceptions(data);
    renderSignals(data);

    $('updated').textContent = `Observed ${data.observed_at || new Date().toISOString()}`;
  } catch (error) {
    $('health').textContent = 'Status unavailable';
    $('execution-path').innerHTML = `<div class="load-error"><strong>Unable to load orchestration status.</strong><span>${esc(error.message || String(error))}</span></div>`;
    $('exceptions').innerHTML = '';
    $('rejections').innerHTML = '';
    $('errors').innerHTML = '';
  }
}

$('refresh').addEventListener('click', load);
load();
