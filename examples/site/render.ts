import type { ArchitectureEntity, SiteModel } from './model.ts';

export const PAGE_FILES = [
  'index.html',
  'how-it-works.html',
  'claims.html',
  'evidence.html',
  'architecture.html',
  'experiments.html',
  'index-of-terms.html',
] as const;

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const NAV = [
  ['index.html', 'Home'],
  ['how-it-works.html', 'How it works'],
  ['claims.html', 'Claims'],
  ['evidence.html', 'Evidence'],
  ['architecture.html', 'Architecture'],
  ['experiments.html', 'Experiments'],
  ['index-of-terms.html', 'Index'],
] as const;

function page(title: string, description: string, body: string): string {
  const nav = NAV.map(([href, label]) => `<a href="${href}">${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)} · Overcenter</title><link rel="stylesheet" href="site.css"></head><body><header class="site-header"><a class="wordmark" href="index.html">Overcenter</a><nav aria-label="Primary">${nav}</nav></header><main>${body}</main><footer><p>Generated from repository authority and evidence records. This site is a projection, not project authority.</p></footer></body></html>`;
}

function hero(eyebrow: string, title: string, lede: string, extra = ''): string {
  return `<section class="hero compact"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(lede)}</p>${extra}</section>`;
}

function section(title: string, body: string): string {
  return `<section class="section"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function architectureAnchor(entity: ArchitectureEntity): string {
  return `${slug(entity.kind)}-${slug(entity.id)}`;
}

export function generateHome(model: SiteModel): string {
  const demonstrated = model.claims.filter((claim) => claim.status === 'Demonstrated').length;
  const supported = model.experiments.filter(
    (experiment) => experiment.outcome === 'supported',
  ).length;
  const metrics = [
    [model.claims.length, 'registered claims'],
    [demonstrated, 'demonstrated claims'],
    [model.experiments.length, 'maintained experiments'],
    [supported, 'supported experiments'],
    [model.architecture.length, 'architecture entities'],
  ]
    .map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`)
    .join('');
  return page(
    'Home',
    model.thesis,
    `<section class="hero"><p class="eyebrow">Executable research prototype</p><h1>${escapeHtml(model.thesis)}</h1><p class="lede">Reasoning agents make judgments. Deterministic software owns execution correctness.</p><pre class="flow"><code>${escapeHtml(model.coreLoop)}</code></pre></section><section class="metrics">${metrics}</section>${section('Follow a claim to its evidence', '<p>The site is generated from the same claim taxonomy, proof map, experiment registry, and relational architecture model that live in the repository.</p><p><a class="cta" href="claims.html">Browse claims →</a></p>')}`,
  );
}

export function generateHowItWorks(model: SiteModel): string {
  return page(
    'How it works',
    'The authority loop and the boundary between judgment and execution correctness.',
    `${hero('Authority loop', 'Workers propose. Authority decides.', 'Known correctness rules stay deterministic; unresolved judgment moves outward.', `<pre class="flow"><code>${escapeHtml(model.coreLoop)}</code></pre>`)}${section('Resolution frontier', '<div class="triptych"><div><strong>1</strong><h3>Deterministic software</h3><p>Known reconciliation, evidence, retry, and recovery.</p></div><div><strong>2</strong><h3>Reasoning agent</h3><p>Investigates what remains uncertain.</p></div><div><strong>3</strong><h3>Human operator</h3><p>Receives the irreducible residue.</p></div></div>')}${section('Projection boundary', '<p>Delete every generated page and the kernel behaves identically. The site cannot claim work, authorize effects, settle evidence, or advance project truth.</p>')}`,
  );
}

export function generateClaims(model: SiteModel): string {
  const groups = new Map<string, typeof model.claims>();
  for (const claim of model.claims)
    groups.set(claim.family, [...(groups.get(claim.family) ?? []), claim]);
  const body = [...groups.entries()]
    .map(([family, claims]) =>
      section(
        family,
        `<div class="grid">${claims
          .map(
            (claim) =>
              `<article class="card" id="claim-${slug(claim.id)}"><h3>${escapeHtml(`${claim.id}. ${claim.title}`)}</h3><p class="status">${escapeHtml(claim.status)}</p><p>${escapeHtml(claim.statement)}</p></article>`,
          )
          .join('')}</div>`,
      ),
    )
    .join('');
  return page(
    'Claims',
    'Overcenter claims, status, and scope.',
    `${hero('Claim taxonomy', 'Say exactly what is established.', 'Safety, liveness, provenance, and reuse remain separate promises.')}${body}`,
  );
}

export function generateEvidence(model: SiteModel): string {
  const rows = model.proofObligations
    .map(
      (row, index) =>
        `<article class="evidence-row" id="evidence-${index + 1}"><h3>${escapeHtml(row.obligation)}</h3><dl><div><dt>Implementation</dt><dd>${escapeHtml(row.implementation)}</dd></div><div><dt>Local adversarial</dt><dd>${escapeHtml(row.localAdversarial)}</dd></div><div><dt>Formal</dt><dd>${escapeHtml(row.formal)}</dd></div><div><dt>Live provider</dt><dd>${escapeHtml(row.liveProvider)}</dd></div><div><dt>Current boundary</dt><dd>${escapeHtml(row.boundary)}</dd></div></dl></article>`,
    )
    .join('');
  return page(
    'Evidence',
    'The layer-by-layer witness map behind Overcenter claims.',
    `${hero('Witness map', 'Green means something specific.', 'Implementation, adversarial, formal, and live-provider evidence remain distinct.')}${section('Proof obligations', `<div class="evidence-list">${rows}</div>`)}`,
  );
}

export function generateArchitecture(model: SiteModel): string {
  const groups = new Map<string, ArchitectureEntity[]>();
  for (const entity of model.architecture)
    groups.set(entity.kind, [...(groups.get(entity.kind) ?? []), entity]);
  const body = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, entities]) =>
      section(
        `${kind.replaceAll('_', ' ')} · ${entities.length}`,
        `<div class="chip-grid">${entities
          .map(
            (entity) =>
              `<div class="chip" id="${architectureAnchor(entity)}">${escapeHtml(entity.id)}</div>`,
          )
          .join('')}</div>`,
      ),
    )
    .join('');
  return page(
    'Architecture',
    'A generated projection of Overcenter relational architecture entities.',
    `${hero('Relational architecture', 'Vocabulary becomes a navigable surface.', 'Identifiers come directly from logic.sql and physics.sql; the site keeps no shadow catalog.')}${body}`,
  );
}

export function generateExperiments(model: SiteModel): string {
  const cards = model.experiments
    .map(
      (experiment) =>
        `<article class="card" id="experiment-${slug(experiment.id)}"><h3>${escapeHtml(experiment.id)}</h3><p class="status">${escapeHtml(experiment.outcome)}</p><p><strong>Question.</strong> ${escapeHtml(experiment.question)}</p><p><strong>Claim.</strong> ${escapeHtml(experiment.claim)}</p><p><strong>Result.</strong> ${escapeHtml(experiment.summary)}</p><p class="meta">Evidence: ${escapeHtml(experiment.evidenceStatus)}${experiment.evaluatedRevision ? ` · revision <code>${escapeHtml(experiment.evaluatedRevision)}</code>` : ''}</p></article>`,
    )
    .join('');
  return page(
    'Experiments',
    'Maintained Overcenter experiments and bounded outcomes.',
    `${hero('Maintained experiments', 'Failures teach architecture too.', 'The registry explains evidence; it does not decide project truth.')}${section('Experiment corpus', `<div class="grid">${cards}</div>`)}`,
  );
}

export function generateIndex(model: SiteModel): string {
  const claims = model.claims
    .map(
      (claim) =>
        `<li><a href="claims.html#claim-${slug(claim.id)}">${escapeHtml(`${claim.id} · ${claim.title}`)}</a><span>${escapeHtml(claim.status)}</span></li>`,
    )
    .join('');
  const experiments = model.experiments
    .map(
      (experiment) =>
        `<li><a href="experiments.html#experiment-${slug(experiment.id)}">${escapeHtml(experiment.id)}</a><span>${escapeHtml(experiment.outcome)}</span></li>`,
    )
    .join('');
  const architecture = model.architecture
    .map(
      (entity) =>
        `<li><a href="architecture.html#${architectureAnchor(entity)}">${escapeHtml(entity.id)}</a><span>${escapeHtml(entity.kind.replaceAll('_', ' '))}</span></li>`,
    )
    .join('');
  return page(
    'Index',
    'A faceted index over claims, experiments, and architecture vocabulary.',
    `${hero('Faceted index', 'One corpus, many ways in.', `${model.claims.length} claims · ${model.experiments.length} experiments · ${model.architecture.length} architecture entities`)}${section('Claims', `<ul class="index-list">${claims}</ul>`)}${section('Experiments', `<ul class="index-list">${experiments}</ul>`)}${section('Architecture', `<ul class="index-list">${architecture}</ul>`)}`,
  );
}

export const generators = [
  ['index.html', generateHome],
  ['how-it-works.html', generateHowItWorks],
  ['claims.html', generateClaims],
  ['evidence.html', generateEvidence],
  ['architecture.html', generateArchitecture],
  ['experiments.html', generateExperiments],
  ['index-of-terms.html', generateIndex],
] as const;
