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
  'search.html',
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

const SITE_ROOT = 'https://laurajoyhutchins.github.io/overcenter/';
const REPOSITORY_ROOT = 'https://github.com/laurajoyhutchins/overcenter/blob/main/';

const NAV = [
  ['index.html', 'Home'],
  ['how-it-works.html', 'How it works'],
  ['claims.html', 'Claims'],
  ['evidence.html', 'Evidence'],
  ['architecture.html', 'Architecture'],
  ['experiments.html', 'Experiments'],
  ['index-of-terms.html', 'Index'],
  ['search.html', 'Search'],
] as const;

function page(file: string, title: string, description: string, body: string): string {
  const nav = NAV.map(([href, label]) =>
    href === file
      ? `<a href="${href}" aria-current="page">${label}</a>`
      : `<a href="${href}">${label}</a>`,
  ).join('');
  const canonical = file === 'index.html' ? SITE_ROOT : `${SITE_ROOT}${file}`;
  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: 'Overcenter',
    description,
    url: canonical,
    codeRepository: 'https://github.com/laurajoyhutchins/overcenter',
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    programmingLanguage: 'TypeScript',
  }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${canonical}"><meta property="og:site_name" content="Overcenter"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)} · Overcenter"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(title)} · Overcenter"><meta name="twitter:description" content="${escapeHtml(description)}"><title>${escapeHtml(title)} · Overcenter</title><link rel="stylesheet" href="site.css"><script type="application/ld+json">${structuredData}</script></head><body><header class="site-header"><a class="wordmark" href="index.html">Overcenter</a><nav aria-label="Primary">${nav}</nav></header><main>${body}</main><footer><p>Generated from repository authority and evidence records. This site is a projection, not project authority.</p></footer></body></html>`;
}

function pageIntro(title: string, lede: string, extra = ''): string {
  return `<section class="page-intro"><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(lede)}</p>${extra}</section>`;
}

function section(title: string, body: string, id?: string): string {
  const idAttribute = id ? ` id="${escapeHtml(id)}"` : '';
  return `<section class="section"${idAttribute}><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function architectureAnchor(entity: ArchitectureEntity): string {
  return `${slug(entity.kind)}-${slug(entity.id)}`;
}

function proofAnchor(obligation: string): string {
  return `proof-${slug(obligation)}`;
}

function repositorySourceUrl(path: string): string {
  const file = path.split('#', 1)[0] ?? path;
  return `${REPOSITORY_ROOT}${file
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function sourceLinks(paths: string[]): string {
  if (paths.length === 0) return '';
  return `<ul class="source-links">${paths
    .map(
      (path) =>
        `<li><a href="${repositorySourceUrl(path)}"><code>${escapeHtml(path)}</code></a></li>`,
    )
    .join('')}</ul>`;
}

function recordLinks(
  model: SiteModel,
): Map<string, Array<{ href: string; label: string; kind: string }>> {
  const refs = new Map<string, Array<{ href: string; label: string; kind: string }>>();
  const add = (path: string, href: string, label: string, kind: string) => {
    const current = refs.get(path) ?? [];
    if (!current.some((entry) => entry.href === href)) current.push({ href, label, kind });
    refs.set(path, current);
  };

  for (const claim of model.claims) {
    for (const path of claim.repositoryRefs) {
      add(path, `claims.html#claim-${slug(claim.id)}`, `${claim.id} · ${claim.title}`, 'claim');
    }
  }
  for (const proof of model.proofObligations) {
    for (const path of proof.repositoryRefs) {
      add(path, `evidence.html#${proofAnchor(proof.obligation)}`, proof.obligation, 'proof');
    }
  }
  for (const experiment of model.experiments) {
    for (const path of experiment.repositoryRefs) {
      add(path, `experiments.html#experiment-${slug(experiment.id)}`, experiment.id, 'experiment');
    }
  }
  return refs;
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
    : '';
  const implementation =
    claim.repositoryRefs.length > 0
      ? `<div><span>Referenced source</span>${sourceLinks(claim.repositoryRefs)}</div>`
      : '';
  return `<div class="claim-provenance"><p><span>Source</span> <a href="${repositorySourceUrl('research/claims.md')}"><code>research/claims.md · ${escapeHtml(claim.id)}</code></a></p>${verification}<p><span>Evidence</span> <a href="evidence.html">Proof obligation register</a></p>${implementation}</div>`;
}

export function generateHome(model: SiteModel): string {
  const demonstrated = model.claims.filter((claim) => claim.statusKind === 'demonstrated').length;
  const supported = model.experiments.filter(
    (experiment) => experiment.outcomeKind === 'supported',
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
    `<section class="home-intro"><h1>Overcenter</h1><p class="lede">${escapeHtml(model.thesis)}</p><pre class="flow"><code>${escapeHtml(model.coreLoop)}</code></pre></section><section class="metrics">${metrics}</section>${section('Start here', '<ul class="route-list"><li><a href="how-it-works.html"><strong>Understand the model</strong><span>Authority, judgment, and deterministic execution boundaries.</span></a></li><li><a href="evidence.html"><strong>Inspect what is proved</strong><span>Implementation, adversarial, formal, and live-provider evidence.</span></a></li><li><a href="experiments.html"><strong>See the experiments</strong><span>Maintained questions, outcomes, revisions, and source artifacts.</span></a></li><li><a href="architecture.html"><strong>Browse the implementation model</strong><span>Relational architecture identifiers derived from SQL authority.</span></a></li></ul>')}${section('About this site', '<p>These pages are generated from repository records. Claims, proof obligations, experiments, and architecture identifiers are not maintained separately here.</p>')}`,
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
        `family-${slug(family)}`,
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
      (row) =>
        `<article class="evidence-row" id="${proofAnchor(row.obligation)}"><h3>${escapeHtml(row.obligation)}</h3><dl><div><dt>Implementation</dt><dd>${escapeHtml(row.implementation)}</dd></div><div><dt>Local adversarial</dt><dd>${escapeHtml(row.localAdversarial)}</dd></div><div><dt>Formal</dt><dd>${escapeHtml(row.formal)}</dd></div><div><dt>Live provider</dt><dd>${escapeHtml(row.liveProvider)}</dd></div><div><dt>Current boundary</dt><dd>${escapeHtml(row.boundary)}</dd></div></dl>${row.repositoryRefs.length > 0 ? `<div class="evidence-sources"><strong>Referenced source</strong>${sourceLinks(row.repositoryRefs)}</div>` : ''}</article>`,
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
        `architecture-kind-${slug(kind)}`,
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
        `<article class="card" id="experiment-${slug(experiment.id)}"><h3>${escapeHtml(experiment.id)}</h3>${experimentStatus(experiment)}<p><strong>Question.</strong> ${escapeHtml(experiment.question)}</p><p><strong>Claim.</strong> ${escapeHtml(experiment.claim)}</p><p><strong>Result.</strong> ${escapeHtml(experiment.summary)}</p><p class="meta">Evidence: ${escapeHtml(experiment.evidenceStatus)}${experiment.evaluatedRevision ? ` · revision <code>${escapeHtml(experiment.evaluatedRevision)}</code>` : ''}</p>${experiment.repositoryRefs.length > 0 ? `<div class="experiment-sources"><strong>Referenced source</strong>${sourceLinks(experiment.repositoryRefs)}</div>` : ''}</article>`,
    )
    .join('');
  return page(
    'experiments.html',
    'Experiments',
    'Maintained Overcenter experiments and bounded outcomes.',
    `${pageIntro('Experiments', 'Maintained experiments, their questions, outcomes, and evidence status.')}${section('Experiment registry', `<div class="grid">${cards}</div>`)}`,
  );
}

function searchText(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(' ').toLowerCase();
}

function searchRecord(
  kind: string,
  title: string,
  href: string,
  detail: string,
  searchable: string[],
): string {
  return `<article class="search-record" data-search-record data-search-text="${escapeHtml(
    searchText([kind, title, detail, ...searchable]),
  )}"><p class="search-kind">${escapeHtml(kind)}</p><h2><a href="${href}">${escapeHtml(
    title,
  )}</a></h2><p>${escapeHtml(detail)}</p></article>`;
}

export function generateSearch(model: SiteModel): string {
  const claims = model.claims.map((claim) =>
    searchRecord(
      'Claim',
      `${claim.id} · ${claim.title}`,
      `claims.html#claim-${slug(claim.id)}`,
      claim.statement,
      [
        claim.family,
        claim.status,
        claim.statusScope,
        claim.evidenceBoundary,
        ...claim.repositoryRefs,
      ],
    ),
  );
  const proofs = model.proofObligations.map((proof) =>
    searchRecord(
      'Proof obligation',
      proof.obligation,
      `evidence.html#${proofAnchor(proof.obligation)}`,
      proof.boundary,
      [
        proof.implementation,
        proof.localAdversarial,
        proof.formal,
        proof.liveProvider,
        ...proof.repositoryRefs,
      ],
    ),
  );
  const experiments = model.experiments.map((experiment) =>
    searchRecord(
      'Experiment',
      experiment.id,
      `experiments.html#experiment-${slug(experiment.id)}`,
      experiment.question,
      [
        experiment.claim,
        experiment.outcome,
        experiment.summary,
        experiment.evidenceStatus,
        experiment.evaluatedRevision,
        ...experiment.repositoryRefs,
      ],
    ),
  );
  const architecture = model.architecture.map((entity) =>
    searchRecord(
      entity.kind.replaceAll('_', ' '),
      entity.id,
      `architecture.html#${architectureAnchor(entity)}`,
      `Architecture ${entity.kind.replaceAll('_', ' ')}`,
      [entity.kind],
    ),
  );
  const records = [...claims, ...proofs, ...experiments, ...architecture].join('');
  const total = model.claims.length + model.proofObligations.length + model.experiments.length + model.architecture.length;
  const script = `<script type="module">
const input = document.querySelector('#site-record-search');
const count = document.querySelector('#site-search-count');
const records = [...document.querySelectorAll('[data-search-record]')];
const update = () => {
  const terms = (input?.value ?? '').toLowerCase().trim().split(/\\s+/).filter(Boolean);
  let visible = 0;
  for (const record of records) {
    const text = record.getAttribute('data-search-text') ?? '';
    const show = terms.every((term) => text.includes(term));
    record.hidden = !show;
    if (show) visible += 1;
  }
  if (count) count.textContent = terms.length ? \`${visible} matching records\` : \`${records.length} records\`;
};
input?.addEventListener('input', update);
update();
</script>`;
  return page(
    'search.html',
    'Search',
    'Search claims, proof obligations, experiments, and architecture records derived from repository authority.',
    `${pageIntro('Search', 'Search the structured records that generate this site. Results link back to their canonical projection surfaces.', `<label class="search-field" for="site-record-search"><span>Search records</span><input id="site-record-search" type="search" autocomplete="off" spellcheck="false" placeholder="Try exact revision, settlement, GitHub, or authority"></label><p class="search-count" id="site-search-count" aria-live="polite">${total} records</p>`)}<section class="section search-results" aria-label="Search results">${records}</section>${script}`,
  );
}

export function generateIndex(model: SiteModel): string {
  const familyCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const architectureCounts = new Map<string, number>();
  for (const claim of model.claims) {
    familyCounts.set(claim.family, (familyCounts.get(claim.family) ?? 0) + 1);
    const label =
      claim.statusKind === 'other' ? claim.status : CLAIM_STATUS_LABELS[claim.statusKind];
    statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1);
  }
  for (const entity of model.architecture) {
    architectureCounts.set(entity.kind, (architectureCounts.get(entity.kind) ?? 0) + 1);
  }

  const facets = `<div class="facet-grid"><div><h3>Claim families</h3><ul class="index-list">${[
    ...familyCounts.entries(),
  ]
    .map(
      ([family, count]) =>
        `<li><a href="claims.html#family-${slug(family)}">${escapeHtml(family)}</a><span>${count}</span></li>`,
    )
    .join('')}</ul></div><div><h3>Claim states</h3><ul class="index-list">${[
    ...statusCounts.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `<li><span>${escapeHtml(status)}</span><span>${count}</span></li>`)
    .join('')}</ul></div><div><h3>Architecture kinds</h3><ul class="index-list">${[
    ...architectureCounts.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([kind, count]) =>
        `<li><a href="architecture.html#architecture-kind-${slug(kind)}">${escapeHtml(kind.replaceAll('_', ' '))}</a><span>${count}</span></li>`,
    )
    .join('')}</ul></div></div>`;

  const proofObligations = model.proofObligations
    .map(
      (proof) =>
        `<li><a href="evidence.html#${proofAnchor(proof.obligation)}">${escapeHtml(proof.obligation)}</a><span>proof obligation</span></li>`,
    )
    .join('');

  const sharedSources = [...recordLinks(model).entries()]
    .filter(([, references]) => references.length > 1)
    .sort(([leftPath, leftRefs], [rightPath, rightRefs]) => {
      const count = rightRefs.length - leftRefs.length;
      return count !== 0 ? count : leftPath.localeCompare(rightPath);
    })
    .map(
      ([path, references]) =>
        `<article class="reference-entry"><h3><a href="${repositorySourceUrl(path)}"><code>${escapeHtml(path)}</code></a></h3><ul>${references
          .map(
            (reference) =>
              `<li><a href="${reference.href}">${escapeHtml(reference.label)}</a><span>${escapeHtml(reference.kind)}</span></li>`,
          )
          .join('')}</ul></article>`,
    )
    .join('');

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
    'A faceted, relational index over claims, evidence, experiments, and architecture vocabulary.',
    `${pageIntro('Index', `${model.claims.length} claims, ${model.proofObligations.length} proof obligations, ${model.experiments.length} experiments, and ${model.architecture.length} architecture entities.`)}${section('Facets', facets)}${sharedSources ? section('Shared source relationships', `<div class="reference-index">${sharedSources}</div>`) : ''}${section('Proof obligations', `<ul class="index-list">${proofObligations}</ul>`)}${section('Claims', `<ul class="index-list">${claims}</ul>`)}${section('Experiments', `<ul class="index-list">${experiments}</ul>`)}${section('Architecture', `<ul class="index-list">${architecture}</ul>`)}`,
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
  ['search.html', generateSearch],
] as const;
