import {
  ORCHESTRATION_HEALTH_CONDITION_KEYS,
  ORCHESTRATION_STUCK_MINUTES,
  orchestrationHealthFromConditionCounts,
} from 'lib/orchestration-status.js';

const UNKNOWN = null;

function count(value) {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : UNKNOWN;
}

function version(value) {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  const text = String(value).trim().replace(/^v/i, '');
  if (!/^\d+$/.test(text)) return UNKNOWN;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : UNKNOWN;
}

function displayCount(value) { return value == null ? '?' : String(value); }

export function derivePreviewSnapshot(input = {}) {
  const scheduled = count(input.scheduled_runs);
  const interactive = count(input.interactive_runs);
  const leases = count(input.active_leases);
  const legacyRecovery = count(input.recovery_pending);
  const health = input.health_conditions
    ? orchestrationHealthFromConditionCounts(input.health_conditions)
    : Object.freeze({
        healthy: legacyRecovery === null ? null : legacyRecovery === 0,
        unhealthy_count: legacyRecovery,
      });
  const recovery = health.unhealthy_count;
  const runs = scheduled === null || interactive === null ? null : scheduled + interactive;

  return Object.freeze({
    schema: 'preview-snapshot-v1',
    version: version(input.version),
    execution: Object.freeze({ scheduled, interactive }),
    busbar: Object.freeze({ runs, leases, recovery_pending: recovery }),
    github: Object.freeze({ role: 'authority' }),
    linear: Object.freeze({ role: 'projection' }),
    condition: health.healthy === null ? 'unknown' : (health.healthy ? 'healthy' : 'unhealthy'),
  });
}

export function previewVersionLabel(snapshot) {
  return snapshot?.version == null ? 'v?' : `v${snapshot.version}`;
}

export function runtimeVersionFromRequest(req = null, env = globalThis.process?.env || {}) {
  const headers = req?.headers || {};
  return version(
    headers['x-hatchable-deployment-version']
      ?? headers['x-hatchable-project-version']
      ?? headers['x-hatchable-version']
      ?? env.HATCHABLE_DEPLOYMENT_VERSION
      ?? env.HATCHABLE_PROJECT_VERSION
      ?? env.HATCHABLE_VERSION
      ?? null,
  );
}

const SNAPSHOT_SQL = `
SELECT
  count(*) FILTER (WHERE mode = 'scheduled')::int AS scheduled_runs,
  count(*) FILTER (WHERE mode = 'interactive')::int AS interactive_runs,
  (SELECT count(*)::int
     FROM work_leases
    WHERE status IN ('claiming','active','settling')
      AND expires_at > now()) AS active_leases,
  (SELECT count(*)::int FROM orchestration_runs r
    WHERE r.status='active' AND r.deadline_at <= now()) AS overdue_active_runs,
  (SELECT count(*)::int FROM work_lease_slots s JOIN work_leases l ON l.lease_id=s.lease_id
    WHERE s.expires_at <= now() AND l.status IN ('claiming','active','settling')) AS expired_active_slots,
  (SELECT count(*)::int FROM work_leases
    WHERE status='claiming' AND updated_at < now() - interval '${ORCHESTRATION_STUCK_MINUTES} minutes') AS leases_stuck_claiming,
  (SELECT count(*)::int FROM work_leases
    WHERE status='settling' AND updated_at < now() - interval '${ORCHESTRATION_STUCK_MINUTES} minutes') AS leases_stuck_settling,
  (SELECT count(*)::int FROM orchestration_command_invocations i
    WHERE i.outcome='running' AND i.started_at < now() - interval '${ORCHESTRATION_STUCK_MINUTES} minutes'
      AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions r WHERE r.invocation_id=i.invocation_id)) AS journal_stuck_running,
  (SELECT count(*)::int FROM orchestration_command_invocations i
    WHERE i.outcome='indeterminate'
      AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions r WHERE r.invocation_id=i.invocation_id)) AS journal_indeterminate,
  (SELECT count(*)::int FROM github_changeset_receipts
    WHERE state='processing' AND updated_at < now() - interval '${ORCHESTRATION_STUCK_MINUTES} minutes') AS github_changesets_processing,
  (SELECT count(*)::int FROM github_changeset_receipts
    WHERE state='prepared' AND updated_at < now() - interval '${ORCHESTRATION_STUCK_MINUTES} minutes') AS github_changesets_prepared,
  (SELECT count(*)::int FROM portfolio_reconcile_receipts
    WHERE state='processing' AND updated_at < now() - interval '${ORCHESTRATION_STUCK_MINUTES} minutes') AS portfolio_reconcile_processing,
  (SELECT count(*)::int FROM portfolio_reconcile_receipts
    WHERE state='indeterminate') AS portfolio_reconcile_indeterminate
FROM orchestration_runs
WHERE status = 'active'
  AND deadline_at > now()`;

export async function readPreviewSnapshot({ db, versionProvider = null, req = null } = {}) {
  let row = null;
  try {
    if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');
    const result = await db.query(SNAPSHOT_SQL);
    row = result?.rows?.[0] || null;
  } catch {
    row = null;
  }

  let liveVersion = null;
  try {
    liveVersion = versionProvider
      ? await versionProvider()
      : runtimeVersionFromRequest(req);
  } catch {
    liveVersion = null;
  }

  return derivePreviewSnapshot({
    version: liveVersion,
    scheduled_runs: row?.scheduled_runs ?? null,
    interactive_runs: row?.interactive_runs ?? null,
    active_leases: row?.active_leases ?? null,
    health_conditions: row
      ? Object.fromEntries(ORCHESTRATION_HEALTH_CONDITION_KEYS.map((key) => [key, row[key]]))
      : null,
  });
}

export function renderPreviewPage(snapshot) {
  const scheduled = displayCount(snapshot?.execution?.scheduled);
  const interactive = displayCount(snapshot?.execution?.interactive);
  const runs = displayCount(snapshot?.busbar?.runs);
  const leases = displayCount(snapshot?.busbar?.leases);
  const recovery = displayCount(snapshot?.busbar?.recovery_pending);
  const condition = snapshot?.condition || 'unknown';
  const conditionLabel = condition === 'healthy' ? 'NORMAL' : (condition === 'unhealthy' ? 'UNHEALTHY' : 'UNKNOWN');
  const conditionMark = condition === 'healthy' ? '●' : (condition === 'unhealthy' ? '▲' : '○');
  const conditionClass = condition === 'healthy' ? 'ok' : (condition === 'unhealthy' ? 'warn' : 'muted');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Busbar</title>
  <meta name="description" content="Busbar is the portfolio orchestration GitHub App, deployed on Hatchable.">
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;background:#08100e;color:#e7f2ee}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#08100e;padding:40px 20px 28px}main{width:min(100%,680px);margin:0 auto;border-top:1px solid #46645d;border-bottom:1px solid #263d37;padding:0 0 14px}
    header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}header{min-height:48px;border-bottom:1px solid #263d37}h1{margin:0;font-size:1rem;line-height:1;letter-spacing:.18em;font-weight:750}.version{margin-left:10px;color:#829b94;font-size:.72rem;font-weight:700}.identity{display:flex;align-items:baseline}.system-state{display:flex;align-items:center;gap:8px;color:#9ab0aa;font-size:.68rem;letter-spacing:.08em}.system-state .ok{color:#8dd3c1}.system-state .warn{color:#dfc177}.system-state .muted{color:#758c86}
    .diagram{display:block;width:100%;height:auto;margin:16px 0 8px}.grid-line{stroke:#13231f;stroke-width:1}.wire{stroke:#41635b;stroke-width:1.4;fill:none;shape-rendering:crispEdges}.wire-strong{stroke:#668b81;stroke-width:2;fill:none;shape-rendering:crispEdges}.control-bus{stroke:#8ac7b7;stroke-width:4;fill:none;shape-rendering:crispEdges}.terminal{fill:#08100e;stroke:#8ac7b7;stroke-width:2}.junction{fill:#8ac7b7}.relay{fill:#0b1512;stroke:#668b81;stroke-width:1.25;shape-rendering:crispEdges}.authority{fill:#0b1512;stroke:#8ac7b7;stroke-width:1.6;shape-rendering:crispEdges}.projection{fill:#0a1210;stroke:#41635b;stroke-width:1.2;shape-rendering:crispEdges}.label{fill:#e7f2ee;font-size:10px;font-weight:750;letter-spacing:.08em}.sub{fill:#829b94;font-size:8px;letter-spacing:.08em}.tiny{fill:#637b75;font-size:7px;letter-spacing:.06em}.metric{fill:#b9e6da;font-size:14px;font-weight:800}.metric-label{fill:#829b94;font-size:7px;letter-spacing:.08em}.phase{fill:#b9cbc6;font-size:7px;font-weight:700;letter-spacing:.04em}.phase-node{fill:#08100e;stroke:#668b81;stroke-width:1.1;shape-rendering:crispEdges}.phase-node.key{stroke:#8ac7b7;stroke-width:1.5}.status-ok{fill:#8dd3c1}.status-warn{fill:#dfc177}.status-muted{fill:#758c86}
    footer{border-top:1px solid #263d37;padding-top:12px;color:#758c86;font-size:.68rem;letter-spacing:.06em}.footer-label{white-space:nowrap}a{color:#b9e6da;text-decoration:none;font-weight:750;letter-spacing:.05em;border-bottom:1px solid #41635b;padding-bottom:2px}a:hover{border-color:#b9e6da}a:focus-visible{outline:2px solid #8dd3c1;outline-offset:4px}
    @media(max-width:520px){body{padding:20px 12px 18px}header{padding:0 2px}.system-state{font-size:.62rem}.diagram{margin-top:10px}.footer-label{display:none}}
  </style>
</head>
<body>
  <main class="control-sheet">
    <header>
      <div class="identity"><h1>BUSBAR</h1><span class="version">${previewVersionLabel(snapshot)}</span></div>
      <div class="system-state"><span class="${conditionClass}">${conditionMark}</span><span>SYSTEM / ${conditionLabel}</span></div>
    </header>

    <svg class="diagram" viewBox="0 0 420 326" role="img" aria-labelledby="snapshot-title snapshot-desc">
      <title id="snapshot-title">Busbar controls diagram</title>
      <desc id="snapshot-desc">Scheduled and interactive execution feed Busbar run control. GitHub is the authoritative repository state. Linear is the executable-work projection. Each transition follows Enable, Acquire, Execute, Commit, Confirm.</desc>

      <g aria-hidden="true">
        <path class="grid-line" d="M0 42H420 M0 84H420 M0 126H420 M0 168H420 M0 210H420 M0 252H420 M0 294H420"/>
        <path class="grid-line" d="M42 0V326 M84 0V326 M126 0V326 M168 0V326 M210 0V326 M252 0V326 M294 0V326 M336 0V326 M378 0V326"/>
      </g>

      <text class="tiny" x="8" y="16">EXECUTION INPUTS</text>
      <circle class="terminal" cx="20" cy="50" r="5"/>
      <text class="label" x="34" y="48">SCHEDULED</text>
      <text class="sub" x="34" y="60">${scheduled} ACTIVE</text>
      <circle class="terminal" cx="20" cy="90" r="5"/>
      <text class="label" x="34" y="88">INTERACTIVE</text>
      <text class="sub" x="34" y="100">${interactive} ACTIVE</text>
      <path class="wire" d="M25 50H92V70 M25 90H92V70"/>
      <circle class="junction" cx="92" cy="70" r="3"/>

      <path class="control-bus" d="M92 70H356"/>
      <text class="tiny" x="224" y="60" text-anchor="middle">CONTROL BUS</text>
      <path class="wire-strong" d="M210 70V112"/>
      <circle class="junction" cx="210" cy="70" r="3"/>

      <rect class="relay" x="120" y="112" width="180" height="88"/>
      <text class="label" x="130" y="129">RUN CONTROL</text>
      <path class="wire" d="M130 138H290"/>
      <text class="metric" x="150" y="166" text-anchor="middle">${runs}</text>
      <text class="metric-label" x="150" y="181" text-anchor="middle">RUNS</text>
      <text class="metric" x="210" y="166" text-anchor="middle">${leases}</text>
      <text class="metric-label" x="210" y="181" text-anchor="middle">LEASES</text>
      <text class="metric" x="270" y="166" text-anchor="middle">${recovery}</text>
      <text class="metric-label" x="270" y="181" text-anchor="middle">RECOVERY</text>
      <circle class="${condition === 'healthy' ? 'status-ok' : (condition === 'unhealthy' ? 'status-warn' : 'status-muted')}" cx="288" cy="124" r="3"/>

      <path class="wire-strong" d="M356 70H370V116"/>
      <rect class="authority" x="332" y="116" width="78" height="52"/>
      <text class="label" x="371" y="138" text-anchor="middle">GITHUB</text>
      <text class="sub" x="371" y="153" text-anchor="middle">AUTHORITY</text>

      <text class="tiny" x="8" y="223">TRANSITION LIFECYCLE</text>
      <path class="wire" d="M45 252H350"/>
      <rect class="phase-node" x="42" y="246" width="12" height="12"/>
      <rect class="phase-node" x="112" y="246" width="12" height="12"/>
      <rect class="phase-node" x="182" y="246" width="12" height="12"/>
      <rect class="phase-node key" x="252" y="246" width="12" height="12"/>
      <rect class="phase-node key" x="322" y="246" width="12" height="12"/>
      <text class="phase" x="48" y="275" text-anchor="middle">ENABLE</text>
      <text class="phase" x="118" y="275" text-anchor="middle">ACQUIRE</text>
      <text class="phase" x="188" y="275" text-anchor="middle">EXECUTE</text>
      <text class="phase" x="258" y="275" text-anchor="middle">COMMIT</text>
      <text class="phase" x="328" y="275" text-anchor="middle">CONFIRM</text>
      <path class="wire" d="M258 246V212H371V168"/>
      <path class="wire" d="M328 258V292H350"/>
      <circle class="junction" cx="328" cy="252" r="3"/>
      <rect class="projection" x="350" y="280" width="60" height="35"/>
      <text class="label" x="380" y="295" text-anchor="middle">LINEAR</text>
      <text class="tiny" x="380" y="307" text-anchor="middle">PROJECTION</text>
    </svg>

    <footer><span class="footer-label">PORTFOLIO EXECUTION CONTROL</span><a href="/dashboard">OPEN DASHBOARD</a></footer>
  </main>
</body>
</html>`;
}
