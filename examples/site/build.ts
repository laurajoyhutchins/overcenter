import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSiteModel, type SiteModel } from './model.ts';
import { generators, PAGE_FILES, slug } from './render.ts';

export interface BuildSiteOptions {
  root?: string;
  outDir?: string;
}

interface SearchRecord {
  title: string;
  href: string;
  kind: string;
  text: string;
}

const SITE_ROOT = 'https://laurajoyhutchins.github.io/overcenter/';

function renderSitemap(): string {
  const urls = PAGE_FILES.map((file) => {
    const location = file === 'index.html' ? SITE_ROOT : `${SITE_ROOT}${file}`;
    return `  <url><loc>${location}</loc></url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function proofAnchor(obligation: string): string {
  return `proof-${slug(obligation)}`;
}

function searchRecords(model: SiteModel): SearchRecord[] {
  const records: SearchRecord[] = [
    {
      title: 'How Overcenter works',
      href: 'how-it-works.html',
      kind: 'Guide',
      text: `${model.thesis} ${model.coreLoop} authority judgment deterministic software reasoning agent human operator`,
    },
  ];

  for (const claim of model.claims) {
    records.push({
      title: `${claim.id}. ${claim.title}`,
      href: `claims.html#claim-${slug(claim.id)}`,
      kind: 'Claim',
      text: [
        claim.family,
        claim.status,
        claim.statusScope ?? '',
        claim.statement,
        claim.evidenceBoundary ?? '',
        ...claim.repositoryRefs,
      ].join(' '),
    });
  }

  for (const proof of model.proofObligations) {
    records.push({
      title: proof.obligation,
      href: `evidence.html#${proofAnchor(proof.obligation)}`,
      kind: 'Proof obligation',
      text: [
        proof.implementation,
        proof.localAdversarial,
        proof.formal,
        proof.liveProvider,
        proof.boundary,
        ...proof.repositoryRefs,
      ].join(' '),
    });
  }

  for (const experiment of model.experiments) {
    records.push({
      title: experiment.id,
      href: `experiments.html#experiment-${slug(experiment.id)}`,
      kind: 'Experiment',
      text: [
        experiment.question,
        experiment.claim,
        experiment.outcome,
        experiment.summary,
        experiment.evidenceStatus,
        experiment.evaluatedRevision ?? '',
        ...experiment.repositoryRefs,
      ].join(' '),
    });
  }

  for (const entity of model.architecture) {
    records.push({
      title: entity.id,
      href: `architecture.html#${slug(entity.kind)}-${slug(entity.id)}`,
      kind: entity.kind.replaceAll('_', ' '),
      text: `${entity.kind} ${entity.id}`,
    });
  }

  return records;
}

function renderSearchClient(): string {
  return `const trigger = document.querySelector('[data-search-open]');
const dialog = document.querySelector('#site-search');
const input = document.querySelector('[data-search-input]');
const results = document.querySelector('[data-search-results]');
const status = document.querySelector('[data-search-status]');
let records = [];

const normalize = (value) => value.toLocaleLowerCase().normalize('NFKD');

function renderResults(query) {
  if (!(input instanceof HTMLInputElement) || !(results instanceof HTMLOListElement) || !(status instanceof HTMLElement)) return;
  const terms = normalize(query).trim().split(/\\s+/).filter(Boolean);
  results.replaceChildren();

  if (terms.length === 0) {
    status.textContent = records.length ? \`\${records.length} indexed records\` : 'Search index loading…';
    return;
  }

  const matches = records
    .map((record) => {
      const title = normalize(record.title);
      const kind = normalize(record.kind);
      const haystack = normalize(\`\${record.title} \${record.kind} \${record.text}\`);
      if (!terms.every((term) => haystack.includes(term))) return null;
      let score = 0;
      for (const term of terms) {
        if (title === term) score += 12;
        else if (title.startsWith(term)) score += 8;
        else if (title.includes(term)) score += 5;
        if (kind.includes(term)) score += 2;
      }
      return { record, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
    .slice(0, 30);

  status.textContent = matches.length === 1 ? '1 result' : \`\${matches.length} results\`;
  for (const match of matches) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const kind = document.createElement('span');
    link.href = match.record.href;
    link.textContent = match.record.title;
    kind.textContent = match.record.kind;
    item.append(link, kind);
    results.append(item);
  }
}

fetch('search-index.json')
  .then((response) => {
    if (!response.ok) throw new Error(\`search index HTTP \${response.status}\`);
    return response.json();
  })
  .then((value) => {
    records = Array.isArray(value) ? value : [];
    renderResults(input instanceof HTMLInputElement ? input.value : '');
  })
  .catch(() => {
    if (status instanceof HTMLElement) status.textContent = 'Search index unavailable.';
  });

if (trigger instanceof HTMLButtonElement && dialog instanceof HTMLDialogElement) {
  trigger.addEventListener('click', () => {
    dialog.showModal();
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  });
}

if (input instanceof HTMLInputElement) {
  input.addEventListener('input', () => renderResults(input.value));
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const editing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
  if (event.key === '/' && !editing && dialog instanceof HTMLDialogElement) {
    event.preventDefault();
    dialog.showModal();
    if (input instanceof HTMLInputElement) input.focus();
  }
});
`;
}

export async function buildSite(options: BuildSiteOptions = {}): Promise<SiteModel> {
  const root = options.root ?? process.cwd();
  const outDir = options.outDir ?? resolve(root, '.overcenter-build/site');
  const model = await loadSiteModel(root);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await Promise.all(
    generators.map(async ([file, generator]) => {
      await writeFile(resolve(outDir, file), generator(model), 'utf8');
    }),
  );
  await copyFile(resolve(root, 'examples/site/static/site.css'), resolve(outDir, 'site.css'));
  await writeFile(resolve(outDir, '.nojekyll'), '', 'utf8');
  await writeFile(
    resolve(outDir, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_ROOT}sitemap.xml\n`,
    'utf8',
  );
  await writeFile(resolve(outDir, 'sitemap.xml'), renderSitemap(), 'utf8');
  await writeFile(
    resolve(outDir, 'search-index.json'),
    JSON.stringify(searchRecords(model)),
    'utf8',
  );
  await writeFile(resolve(outDir, 'search.js'), renderSearchClient(), 'utf8');
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSite();
}
