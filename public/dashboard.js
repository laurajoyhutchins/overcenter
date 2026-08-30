const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

const PRODUCTIVE_PHASES = Object.freeze(['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM']);

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

function phaseMarkup(transition) {
  const next = transition?.lifecycle?.next_stage;
  const complete = transition?.lifecycle?.complete === true;
  return `<ol class="lifecycle-strip" aria-label="Transition lifecycle">
    ${PRODUCTIVE_PHASES.map((phase) => {
      const phaseClass = complete ? 'phase-complete' : phase === next ? 'phase-current' : '';
      return `<li class="${phaseClass}"><strong>${phase}</strong></li>`;
    }).join('')}
  </ol>`;
}

function executorLabel(executor) {
  if (!executor || typeof executor !== 'object') return 'executor unavailable';
  if (executor.kind === 'agent') return [executor.kind, executor.role, executor.skill].filter(Boolean).join(' · ');
  if (executor.kind === 'operator') return [executor.kind, executor.command].filter(Boolean).join(' · ');
  return String(executor.kind || 'executor unavailable');
}

function transitionMarkup(transition, frontier) {
  const unmet = transition.unmet_requirements || [];
  const requires = transition.requires || [];
  const isFrontier = frontier.has(transition.id);
  const dependencyText = unmet.length
    ? `waiting on ${unmet.join(', ')}`
    : requires.length ? `requires ${requires.join(', ')}` : 'no prerequisites';
  return `<article class="flow-node ${transition.state === 'OFF_NOMINAL' ? 'flow-node-fault' : 'flow-node-clear'}" data-transition="${esc(transition.id)}">
    <div class="node-head">
      <div><span class="node-kicker">${esc(transition.state)}</span><h3>${esc(transition.id)}</h3></div>
      <span class="fault-count" aria-label="priority ${Number(transition.priority || 0)}">${isFrontier ? 'READY' : esc(transition.state)}</span>
    </div>
    <p>${esc(dependencyText)}</p>
    <small>${esc(executorLabel(transition.executor))}</small>
    ${phaseMarkup(transition)}
  </article>`;
}

function journalMarkup(data) {
  const running = data.conditions?.journal_stuck_running || {};
  const indeterminate = data.conditions?.journal_indeterminate || {};
  const faults = Number(running.count || 0) + Number(indeterminate.count || 0);
  const refs = [
    ...(running.oldest_refs || []).map((row) => ({ ...row, journal_state: 'stuck running' })),
    ...(indeterminate.oldest_refs || []).map((row) => ({ ...row, journal_state: 'indeterminate' })),
  ];
  return `<aside class="journal-backplane ${faults ? 'journal-fault' : ''}" aria-label="Kernel command journal diagnostics">
    <div class="journal-title">
      <div><span class="node-kicker">KERNEL BACKPLANE</span><h3>COMMAND JOURNAL</h3></div>
      <span class="fault-count" aria-label="${faults} journal faults">${faults}</span>
    </div>
    <p>Runs, leases, command receipts, and recovery evidence remain diagnostic implementation state. They do not define project transitions.</p>
    ${refs.length ? `<div class="journal-refs">${refs.map((row) => `<div class="journal-ref"><strong>${esc(row.command || 'unknown command')}</strong><span>${esc(row.journal_state)}</span><code>${esc(row.invocation_id || row.run_id || 'unknown ref')}</code></div>`).join('')}</div>` : '<div class="journal-clear">No unresolved journal entries.</div>'}
  </aside>`;
}

function renderExecutionPath(data) {
  if (data?.project?.available !== true) {
    $('execution-path').innerHTML = `<div class="load-error"><strong>Project graph authority unavailable.</strong><span>${esc(data?.project?.error_code || 'PROJECT_GRAPH_UNAVAILABLE')}</span></div>${journalMarkup(data)}`;
    return;
  }
  const transitions = Array.isArray(data.project_transitions) ? data.project_transitions : [];
  const frontier = new Set(data.project.frontier || []);
  const authority = data.project.authority || {};
  const authorityLine = [authority.repository, authority.revision ? String(authority.revision).slice(0, 12) : null, authority.derivation].filter(Boolean).join(' · ');
  $('execution-path').innerHTML = `
    <div class="start-rail" aria-label="Project graph authority"><span>${esc(data.project.project_ref || 'project')}</span><small>${esc(authorityLine || 'authority coordinates unavailable')}</small></div>
    <div class="flow-sequence">${transitions.length ? transitions.map((transition) => transitionMarkup(transition, frontier)).join('') : '<div class="empty-state">Authoritative project graph contains no transitions.</div>'}</div>
    ${journalMarkup(data)}
    <div class="diagram-legend"><span>transition state is derived from the authoritative project graph</span><span>lifecycle phases are substate of one transition</span><span>dependency waits come from requires edges</span></div>`;
}

function formatRef(row) {
  const preferred = [
    ['command', row.command], ['work', row.work_ref], ['repo', row.repo], ['run', row.run_id],
    ['lease', row.lease_id], ['invocation', row.invocation_id], ['branch', row.branch], ['phase', row.phase], ['commit', row.commit_sha],
  ].filter(([, value]) => value != null && value !== '');
  return preferred.map(([label, value]) => `<span><b>${esc(label)}</b> ${esc(value)}</span>`).join('');
}

function renderExceptions(data) {
  const entries = Object.entries(data.conditions || {}).filter(([, value]) => Number(value?.count || 0) > 0);
  $('exceptions').innerHTML = entries.length ? entries.map(([key, value]) => `<article class="evidence-row">
    <div class="evidence-summary"><strong>${esc(CONDITION_LABELS[key] || key.replaceAll('_', ' '))}</strong><span>${Number(value.count || 0)} unresolved</span>${value.oldest_at ? `<small>oldest ${esc(value.oldest_at)}</small>` : ''}</div>
    <div class="ref-list">${(value.oldest_refs || []).length ? value.oldest_refs.map((row) => `<div class="ref-row">${formatRef(row)}</div>`).join('') : '<span class="muted">No exact refs returned.</span>'}</div>
  </article>`).join('') : '<div class="empty-state">No stranded orchestration state is currently reported.</div>';
}

function signalRow(title, count, detail, meta = '') {
  return `<div class="signal-row"><div><strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</div><div class="signal-count">${Number(count || 0)}</div>${meta ? `<small>${esc(meta)}</small>` : ''}</div>`;
}

function renderSignals(data) {
  const rejections = data.recent_expected_rejections || [];
  $('rejections').innerHTML = rejections.length ? rejections.slice(0, 12).map((row) => signalRow(row.error_code || 'rejected', row.count, row.command, row.newest_at ? `latest ${row.newest_at}` : '')).join('') : '<div class="empty-state">No expected rejections in the observed window.</div>';
  const errors = data.recent_error_codes || [];
  $('errors').innerHTML = errors.length ? errors.slice(0, 12).map((row) => signalRow(row.error_code, row.count, '', row.newest_at ? `latest ${row.newest_at}` : '')).join('') : '<div class="empty-state">No error codes in the observed window.</div>';
}

async function load() {
  $('health').textContent = 'Refreshing…';
  try {
    const response = await fetch('/api/orchestration/status', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
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