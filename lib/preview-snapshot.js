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
  const recovery = count(input.recovery_pending);
  const runs = scheduled === null || interactive === null ? null : scheduled + interactive;

  return Object.freeze({
    schema: 'preview-snapshot-v1',
    version: version(input.version),
    execution: Object.freeze({ scheduled, interactive }),
    busbar: Object.freeze({ runs, leases, recovery_pending: recovery }),
    github: Object.freeze({ role: 'authority' }),
    linear: Object.freeze({ role: 'projection' }),
    condition: recovery === null ? 'unknown' : (recovery > 0 ? 'recovering' : 'healthy'),
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
  (SELECT count(*)::int
     FROM orchestration_command_invocations i
    WHERE i.outcome = 'indeterminate'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_invocation_resolutions r
         WHERE r.invocation_id = i.invocation_id
      )) AS recovery_pending
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
    recovery_pending: row?.recovery_pending ?? null,
  });
}

export function renderPreviewPage(snapshot) {
  const scheduled = displayCount(snapshot?.execution?.scheduled);
  const interactive = displayCount(snapshot?.execution?.interactive);
  const runs = displayCount(snapshot?.busbar?.runs);
  const leases = displayCount(snapshot?.busbar?.leases);
  const recovery = displayCount(snapshot?.busbar?.recovery_pending);
  const condition = snapshot?.condition || 'unknown';
  const conditionLabel = condition === 'healthy' ? 'healthy' : (condition === 'recovering' ? 'recovering' : 'state unknown');
  const conditionMark = condition === 'healthy' ? '✓' : (condition === 'recovering' ? '↻' : '?');
  const conditionClass = condition === 'healthy' ? 'ok' : (condition === 'recovering' ? 'warn' : 'muted');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Busbar</title>
  <meta name="description" content="Busbar is the portfolio orchestration GitHub App, deployed on Hatchable.">
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1110;color:#edf7f3}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b1110}
    main{width:min(100%,520px);padding:24px 24px 20px;background:#121a18;border:1px solid #28453e;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.28)}
    header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin:0;font-size:1.25rem;line-height:1;letter-spacing:-.02em}.version{font:650 .76rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#89a49c}
    .diagram{display:block;width:100%;height:auto;margin:14px auto 12px}.line{stroke:#365b52;stroke-width:1.5;fill:none}.node{fill:#17241f;stroke:#3f6d61;stroke-width:1.25}.core{fill:#15201d;stroke:#65aa97;stroke-width:1.4}.dot{fill:#85cbb8}.dot-muted{fill:#365b52}.label{fill:#edf7f3;font-size:12px;font-weight:650}.sub{fill:#89a49c;font-size:10px}.metric{fill:#b7eadc;font-size:11px;font-weight:650}.tiny{fill:#718d85;font-size:9px}.ok{color:#8ce0c8}.warn{color:#e1ca8d}.muted{color:#89a49c}
    footer{padding-top:14px;border-top:1px solid #223b35;font-size:.78rem;color:#89a49c}.condition{display:flex;align-items:center;gap:7px}.condition b{font-size:.9rem}a{color:#b7eadc;font-weight:650;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible{outline:2px solid #8ce0c8;outline-offset:4px;border-radius:3px}
    @media(max-width:430px){body{padding:14px}main{padding:20px 16px 17px}.diagram{margin-top:10px}h1{font-size:1.1rem}.label{font-size:11px}.sub,.metric{font-size:9.5px}}
  </style>
</head>
<body>
  <main>
    <header><h1>Busbar</h1><span class="version">${previewVersionLabel(snapshot)}</span></header>
    <svg class="diagram" viewBox="0 0 420 238" role="img" aria-labelledby="snapshot-title snapshot-desc">
      <title id="snapshot-title">Busbar system snapshot</title>
      <desc id="snapshot-desc">Scheduled and interactive execution flow into Busbar. Busbar coordinates authoritative GitHub repository state and a Linear executable-work projection.</desc>

      <text class="sub" x="105" y="17" text-anchor="middle">scheduled</text>
      <circle class="${snapshot?.execution?.scheduled === 0 ? 'dot-muted' : 'dot'}" cx="105" cy="35" r="7"/>
      <text class="tiny" x="105" y="55" text-anchor="middle">${scheduled} active</text>
      <text class="sub" x="315" y="17" text-anchor="middle">interactive</text>
      <circle class="${snapshot?.execution?.interactive === 0 ? 'dot-muted' : 'dot'}" cx="315" cy="35" r="7"/>
      <text class="tiny" x="315" y="55" text-anchor="middle">${interactive} active</text>
      <path class="line" d="M105 43 L155 76 M315 43 L265 76"/>

      <rect class="core" x="110" y="76" width="200" height="90" rx="12"/>
      <text class="label" x="210" y="99" text-anchor="middle">BUSBAR</text>
      <text class="metric" x="144" y="126" text-anchor="middle">${runs}</text><text class="tiny" x="144" y="141" text-anchor="middle">runs</text>
      <text class="metric" x="210" y="126" text-anchor="middle">${leases}</text><text class="tiny" x="210" y="141" text-anchor="middle">leases</text>
      <text class="metric" x="276" y="126" text-anchor="middle">${recovery}</text><text class="tiny" x="276" y="141" text-anchor="middle">recovery</text>

      <path class="line" d="M165 166 L105 195 M255 166 L315 195"/>
      <rect class="node" x="38" y="195" width="134" height="35" rx="9"/><text class="label" x="105" y="211" text-anchor="middle">GitHub</text><text class="sub" x="105" y="224" text-anchor="middle">authority</text>
      <rect class="node" x="248" y="195" width="134" height="35" rx="9"/><text class="label" x="315" y="211" text-anchor="middle">Linear</text><text class="sub" x="315" y="224" text-anchor="middle">projection</text>
    </svg>
    <footer><span class="condition"><b class="${conditionClass}">${conditionMark}</b>${conditionLabel}</span><a href="/dashboard">Open dashboard</a></footer>
  </main>
</body>
</html>`;
}
