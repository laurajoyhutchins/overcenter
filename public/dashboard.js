const endpoints = {
  status: '/api/status',
  entities: '/api/entities?limit=200',
  decisions: '/api/owner-decisions',
};

const state = { entities: [] };
const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  node.replaceChildren();
}

function text(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function metric(label, value, detail) {
  const node = element('article', 'metric');
  node.append(element('span', '', label), element('strong', '', value));
  if (detail) node.append(element('span', '', detail));
  return node;
}

function meta(items) {
  const row = element('div', 'meta');
  for (const item of items.filter(Boolean)) row.append(element('span', '', item));
  return row;
}

function workCard(projection) {
  const portfolio = projection.portfolio || {};
  const node = element('article', 'card');
  node.dataset.state = portfolio.state || '';
  const heading = element('div', 'entity-top');
  const title = element('div');
  title.append(
    element('h3', '', portfolio.title || portfolio.semantic_key || projection.entity_key),
    element('div', 'code', projection.entity_key),
  );
  heading.append(title, element('span', 'badge', portfolio.state || projection.lifecycle || 'unknown'));
  node.append(
    heading,
    meta([
      portfolio.repository,
      portfolio.priority && `priority ${portfolio.priority}`,
      portfolio.route && `route ${portfolio.route}`,
      portfolio.risk_class && `risk ${portfolio.risk_class}`,
    ]),
  );
  if (portfolio.objective) node.append(element('p', 'detail', portfolio.objective));
  if (projection.blockers?.length) {
    node.append(element(
      'p',
      'detail',
      projection.blockers.map((item) => item.description || item.code).join(' · '),
    ));
  }
  node.append(
    element('p', 'next', projection.next_action || 'No next action recorded.'),
    element('div', 'code', `revision ${text(projection.projection_sha256)}`),
  );
  return node;
}

function entityCard(projection) {
  const node = element('article', 'entity');
  const portfolio = projection.portfolio || {};
  const heading = element('div', 'entity-top');
  const title = element('div');
  title.append(
    element('h3', '', portfolio.title || portfolio.semantic_key || projection.entity_key),
    element('div', 'code', projection.entity_key),
  );
  heading.append(title, element('span', 'badge', portfolio.state || projection.lifecycle || 'observed'));
  const lore = projection.lore || {};
  const deciduous = projection.deciduous || {};
  node.append(
    heading,
    meta([
      portfolio.repository,
      `${lore.records?.length || 0} LORE records`,
      `${lore.open_findings?.length || 0} open findings`,
      `${deciduous.unresolved?.length || 0} active graph nodes`,
      projection.github?.head_sha && `head ${String(projection.github.head_sha).slice(0, 8)}`,
    ]),
    element('p', 'next', projection.next_action || 'No next action recorded.'),
    element('div', 'code', `revision ${text(projection.projection_sha256)}`),
  );
  return node;
}

async function json(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Request failed with HTTP ${response.status}`);
  return body;
}

function renderMetrics(status) {
  const node = byId('metrics');
  clear(node);
  node.append(
    metric('Observations', status.observation_count || 0, 'append-only facts'),
    metric('Projections', status.projection_count || 0, 'deterministic views'),
    metric('Discrepancies', status.projections_with_discrepancies || 0, 'need reconciliation'),
    metric('Recent runs', status.recent_runs?.length || 0, 'retained receipts'),
  );
}

function renderEntities() {
  const query = byId('filter').value.trim().toLowerCase();
  const node = byId('entities');
  clear(node);
  const filtered = state.entities.filter((projection) =>
    !query || JSON.stringify(projection).toLowerCase().includes(query)
  );
  if (!filtered.length) {
    node.append(element('p', 'empty', 'No source state matches this filter.'));
    return;
  }
  for (const projection of filtered) node.append(entityCard(projection));
}

function renderBlocked() {
  const node = byId('blocked-work');
  clear(node);
  const blocked = state.entities.filter((projection) =>
    !projection.terminal && (!projection.executable || projection.blockers?.length)
  );
  if (!blocked.length) {
    node.append(element('p', 'empty', 'No blocked work.'));
    return;
  }
  for (const projection of blocked.slice(0, 20)) node.append(workCard(projection));
}

function renderDecisions(decisions) {
  const node = byId('owner-decisions');
  clear(node);
  if (!decisions.length) {
    node.append(element('p', 'empty', 'No owner decisions are waiting.'));
    return;
  }
  for (const projection of decisions) {
    const card = workCard(projection);
    for (const decision of projection.owner_action?.decisions || []) {
      card.append(element('p', 'detail', `${decision.category}: ${decision.summary}`));
    }
    node.append(card);
  }
}

async function refresh() {
  const health = byId('health');
  health.textContent = 'Refreshing source state…';
  health.classList.remove('error');
  try {
    const [status, entities, decisions] = await Promise.all([
      json(endpoints.status),
      json(endpoints.entities),
      json(endpoints.decisions),
    ]);
    state.entities = entities.entities || [];
    renderMetrics(status);
    renderBlocked();
    renderDecisions(decisions.entities || decisions.decisions || []);
    renderEntities();
    health.textContent = 'Control plane healthy';
    byId('updated').textContent = `Updated ${new Date().toLocaleString()}`;
  } catch (error) {
    health.textContent = error.message;
    health.classList.add('error');
  }
}

// Dynamic result containers use aria-live in the page shell for accessible refresh feedback.
byId('refresh').addEventListener('click', refresh);
byId('filter').addEventListener('input', renderEntities);
refresh();