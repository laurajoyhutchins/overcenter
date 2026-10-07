import type {
  ArchitectureEntity,
  Claim,
  ClaimStatusKind,
  Experiment,
  ExperimentOutcomeKind,
  SiteModel,
} from './model.ts';

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

function page(file: string, title: string, description: string, body: string): string {
  const nav = NAV.map(([href, label]) =>
    href === file
      ? `<a href="${href}" aria-current="page">${label}</a>`
      : `<a href="${href}">${label}</a>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)} · Overcenter</title><link rel="stylesheet" href="site.css"></head><body><header class="site-header"><a class="wordmark" href="index.html">Overcenter</a><nav aria-label="Primary">${nav}</nav></header><main>${body}</main><footer><p>Generated from repository authority and evidence records. This site is a projection, not project authority.</p></footer></body></html>`;
}

function pageIntro(title: string, lede: string, extra = ''): string {
  return `<section class="page-intro"><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(lede)}</p>${extra}</section>`;
}

function section(title: string, body: string): string {
  return `<section class="section"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function architectureAnchor(entity: ArchitectureEntity): string {
  return `${slug(entity.kind)}-${slug(entity.id)}`;
}

const CLAIM_STATUS_LABELS: Record<ClaimStatusKind, string> = {
  demonstrated: 'Demonstrated',
  'architectural-requirement': 'Architectural requirement',
  'research-target': 'Research target',
  'non-claim': 'Non-claim',
  'safety-constraint': 'Safety constraint',
  other: 'Other',
};

const EXPERIMENT_OUTCOME_LABELS: Record<ExperimentOutcomeKind, string> = {
  supported: 'Supported',
  mixed: 'Mixed',
  pending: 'Pending',
  unknown: 'Unknown',
  other: 'Other',
};

function claimStatus(claim: Claim): string {
  const label = claim.statusKind === 'other' ? claim.status : CLAIM_STATUS_LABELS[claim.statusKind];
  const scope = claim.statusScope
    ? `<p class="status-scope">${escapeHtml(claim.statusScope)}</p>`
    : '';
  return `<div class="status-block"><p class="status status-${claim.statusKind}">${escapeHtml(label)}</p>${scope}</div>`;
}

function experimentStatus(experiment: Experiment): string {
  const label =
    experiment.outcomeKind === 'other'
      ? experiment.outcome
      : EXPERIMENT_OUTCOME_LABELS[experiment.outcomeKind];
  return `<p class="status status-${experiment.outcomeKind}">${escapeHtml(label)}</p>`;
}

function claimProvenance(claim: Claim): string {
  const verification = claim.evidenceBoundary
    ? `<p><span>Verification</span> ${escapeHtml(claim.evidenceBoundary)}</p>`
    : '<p><span>Evidence</span> <a href="evidence.html">Proof obligation register</a></p>';
  return `<div class="claim-provenance"><p><span>Source</span> <code>research/claims.md · ${escapeHtml(claim.id)}</code></p>${verification}</div>`;
}

export function generateHome(model: SiteModel): string {
  const demonstrated = model.claims.filter((claim) => claim.statusKind === 'demonstrated').length;
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
    'index.html',
    'Home',
    model.thesis,
    `<section class="home-intro"><h1>Overcenter</h1><p class="lede">${escapeHtml(model.thesis)}</p><pre class="flow"><code>${escapeHtml(model.coreLoop)}</code></pre></section><section class="metrics">${metrics}</section>${section('About this site', '<p>These pages are generated from repository records. Claims, proof obligations, experiments, and architecture identifiers are not maintained separately here.</p><p><a href="claims.html">Browse claims</a></p>')}`,
  );
}

export function generateHowItWorks(model: SiteModel): string {
  return page(
    'how-it-works.html',
    'How it works',
    'The authority loop and the boundary between judgment and execution correctness.',
    `${pageIntro('How Overcenter works', 'The kernel keeps known execution rules deterministic and leaves unresolved judgment to an agent or operator.', `<pre class="flow"><code>${escapeHtml(model.coreLoop)}</code></pre>`)}${section('Responsibility boundaries', '<dl class="responsibility-list"><div><dt>Deterministic software</dt><dd>Reconciliation, evidence checks, retry, and recovery when the rules are known.</dd></div><div><dt>Reasoning agent</dt><dd>Investigates cases that are not yet reducible to deterministic rules.</dd></div><div><dt>Human operator</dt><dd>Handles decisions that remain outside the automated boundary.</dd></div></dl>')}${section('Generated-site boundary', '<p>The generated site is read-only. Removing it does not change admission, execution, evidence, recovery, or settlement behavior.</p>')}`,
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
              `<article class="card" id="claim-${slug(claim.id)}"><h3>${escapeHtml(`${claim.id}. ${claim.title}`)}</h3>${claimStatus(claim)}<p>${escapeHtml(claim.statement)}</p>${claimProvenance(claim)}</article>`,
          )
          .join('')}</div>`,
      ),
    )
    .join('');
  return page(
    'claims.html',
    'Claims',
    'Overcenter claims, status, and scope.',
    `${pageIntro('Claims', 'Registered claims and their current status. Safety, liveness, provenance, and reuse are tracked separately.')}${body}`,
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
    'evidence.html',
    'Evidence',
    'The layer-by-layer witness map behind Overcenter claims.',
    `${pageIntro('Evidence', 'Implementation, adversarial, formal, and live-provider evidence are reported separately.')}${section('Proof obligations', `<div class="evidence-list">${rows}</div>`)}`,
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
    'architecture.html',
    'Architecture',
    'A generated projection of Overcenter relational architecture entities.',
    `${pageIntro('Architecture', 'Identifiers are extracted directly from logic.sql and physics.sql. The site does not maintain a separate catalog.')}${body}`,
  );
}

export function generateExperiments(model: SiteModel): string {
  const cards = model.experiments
    .map(
      (experiment) =>
        `<article class="card" id="experiment-${slug(experiment.id)}"><h3>${escapeHtml(experiment.id)}</h3>${experimentStatus(experiment)}<p><strong>Question.</strong> ${escapeHtml(experiment.question)}</p><p><strong>Claim.</strong> ${escapeHtml(experiment.claim)}</p><p><strong>Result.</strong> ${escapeHtml(experiment.summary)}</p><p class="meta">Evidence: ${escapeHtml(experiment.evidenceStatus)}${experiment.evaluatedRevision ? ` · revision <code>${escapeHtml(experiment.evaluatedRevision)}</code>` : ''}</p></article>`,
    )
    .join('');
  return page(
    'experiments.html',
    'Experiments',
    'Maintained Overcenter experiments and bounded outcomes.',
    `${pageIntro('Experiments', 'Maintained experiments, their questions, outcomes, and evidence status.')}${section('Experiment registry', `<div class="grid">${cards}</div>`)}`,
  );
}

export function generateIndex(model: SiteModel): string {
  const claims = model.claims
    .map(
      (claim) =>
        `<li><a href="claims.html#claim-${slug(claim.id)}">${escapeHtml(`${claim.id} · ${claim.title}`)}</a><span>${escapeHtml(claim.statusKind === 'other' ? claim.status : CLAIM_STATUS_LABELS[claim.statusKind])}</span></li>`,
    )
    .join('');
  const experiments = model.experiments
    .map(
      (experiment) =>
        `<li><a href="experiments.html#experiment-${slug(experiment.id)}">${escapeHtml(experiment.id)}</a><span>${escapeHtml(experiment.outcomeKind === 'other' ? experiment.outcome : EXPERIMENT_OUTCOME_LABELS[experiment.outcomeKind])}</span></li>`,
    )
    .join('');
  const architecture = model.architecture
    .map(
      (entity) =>
        `<li><a href="architecture.html#${architectureAnchor(entity)}">${escapeHtml(entity.id)}</a><span>${escapeHtml(entity.kind.replaceAll('_', ' '))}</span></li>`,
    )
    .join('');
  return page(
    'index-of-terms.html',
    'Index',
    'A faceted index over claims, experiments, and architecture vocabulary.',
    `${pageIntro('Index', `${model.claims.length} claims, ${model.experiments.length} experiments, and ${model.architecture.length} architecture entities.`)}${section('Claims', `<ul class="index-list">${claims}</ul>`)}${section('Experiments', `<ul class="index-list">${experiments}</ul>`)}${section('Architecture', `<ul class="index-list">${architecture}</ul>`)}`,
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
