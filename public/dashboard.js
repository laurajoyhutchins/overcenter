const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

function metric(label, value, detail = '') {
  return `<article class="metric"><p>${esc(label)}</p><strong>${esc(value)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</article>`;
}

function card(title, detail, meta = '') {
  return `<article class="card"><h3>${esc(title)}</h3><p>${esc(detail)}</p>${meta ? `<small>${esc(meta)}</small>` : ''}</article>`;
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

    const conditions = Object.entries(data.conditions || {});
    const stranded = conditions.reduce((sum, [, value]) => sum + Number(value?.count || 0), 0);
    const commands = data.recent_command_outcomes || [];
    const successes = commands.filter((row) => row.outcome === 'succeeded').reduce((sum, row) => sum + Number(row.count || 0), 0);
    const rejections = commands.filter((row) => row.outcome === 'rejected').reduce((sum, row) => sum + Number(row.count || 0), 0);

    $('health').textContent = data.healthy ? 'Healthy' : `${stranded} stranded condition${stranded === 1 ? '' : 's'}`;
    $('metrics').innerHTML = [
      metric('Kernel health', data.healthy ? 'healthy' : 'attention'),
      metric('Stranded', stranded, `${conditions.length} monitored conditions`),
      metric('Successful commands', successes, `${data.observed_window_hours}h window`),
      metric('Expected rejections', rejections, 'fail-closed signals'),
    ].join('');

    $('conditions').innerHTML = conditions.length
      ? conditions.map(([name, value]) => card(name.replaceAll('_',' '), `${value.count || 0} unresolved`, value.oldest_at ? `oldest ${value.oldest_at}` : 'clear')).join('')
      : card('No condition data', 'Status projection returned no monitored conditions.');

    const errors = data.recent_error_codes || [];
    $('errors').innerHTML = errors.length
      ? errors.slice(0, 12).map((row) => card(row.error_code, `${row.count} occurrence${Number(row.count) === 1 ? '' : 's'}`, row.newest_at ? `latest ${row.newest_at}` : '')).join('')
      : card('No recent errors', 'No error codes were observed in the current window.');

    $('commands').innerHTML = commands.length
      ? commands.map((row) => card(row.command, row.outcome, `${row.count} invocation${Number(row.count) === 1 ? '' : 's'}`)).join('')
      : card('No recent commands', 'No command traffic in the current window.');

    $('updated').textContent = `Observed ${data.observed_at || new Date().toISOString()}`;
  } catch (error) {
    $('health').textContent = 'Status unavailable';
    $('conditions').innerHTML = card('Unable to load orchestration status', error.message || String(error));
  }
}

$('refresh').addEventListener('click', load);
load();