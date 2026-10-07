import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSite } from '../examples/site/build.ts';
import { escapeHtml, PAGE_FILES, slug } from '../examples/site/render.ts';

test('site projection conserves source records and internal links', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'overcenter-site-'));
  try {
    const model = await buildSite({ outDir });
    const pages = new Map<string, string>();
    for (const file of PAGE_FILES) {
      pages.set(file, await readFile(join(outDir, file), 'utf8'));
    }

    const siteCss = await readFile(join(outDir, 'site.css'), 'utf8');
    for (const token of [
      '--ink: #111827',
      '--cream: #F8F6ED',
      '--midnight: #041019',
      '--phthalo-blue: #063B5D',
      '--phthalo-green: #0B6B5D',
      '--teal: #0E8F84',
      '--cyan: #35E2D2',
      '--mint: #B9F5DB',
      '--blush: #FF8FC8',
      '--periwinkle: #9ED4FF',
      '--violet: #9287FF',
      '--lemon: #FFF250',
      'Georgia',
      'Verdana',
      'Trebuchet MS',
      'Courier New',
    ]) {
      assert.ok(siteCss.includes(token), `Phthalo site contract missing: ${token}`);
    }
    assert.ok(siteCss.includes('background: var(--midnight)'));

    const home = pages.get('index.html') ?? '';
    const claims = pages.get('claims.html') ?? '';
    const evidence = pages.get('evidence.html') ?? '';
    const experiments = pages.get('experiments.html') ?? '';
    const architecture = pages.get('architecture.html') ?? '';
    const index = pages.get('index-of-terms.html') ?? '';
    const search = pages.get('search.html') ?? '';

    const robots = await readFile(join(outDir, 'robots.txt'), 'utf8');
    const sitemap = await readFile(join(outDir, 'sitemap.xml'), 'utf8');
    assert.ok(
      robots.includes('Sitemap: https://laurajoyhutchins.github.io/overcenter/sitemap.xml'),
    );
    for (const file of PAGE_FILES) {
      const expected =
        file === 'index.html'
          ? 'https://laurajoyhutchins.github.io/overcenter/'
          : `https://laurajoyhutchins.github.io/overcenter/${file}`;
      assert.ok(sitemap.includes(`<loc>${expected}</loc>`), `sitemap missing: ${file}`);
    }

    for (const [file, html] of pages) {
      assert.ok(html.includes('rel="canonical"'), `canonical metadata missing: ${file}`);
      assert.ok(html.includes('property="og:title"'), `OpenGraph metadata missing: ${file}`);
      assert.ok(
        html.includes('type="application/ld+json"'),
        `structured metadata missing: ${file}`,
      );
    }
    for (const target of [
      'how-it-works.html',
      'evidence.html',
      'experiments.html',
      'architecture.html',
    ]) {
      assert.ok(home.includes(`href="${target}"`), `home route missing: ${target}`);
    }
    assert.ok(search.includes('id="site-record-search"'), 'structured search input missing');
    assert.ok(search.includes('data-search-record'), 'structured search records missing');
    assert.ok(search.includes("addEventListener('input', update)"), 'structured search behavior missing');
    const expectedSearchRecords =
      model.claims.length +
      model.proofObligations.length +
      model.experiments.length +
      model.architecture.length;
    assert.equal(
      [...search.matchAll(/data-search-record/g)].length,
      expectedSearchRecords,
      'structured search must conserve every searchable record',
    );
    for (const claim of model.claims) {
      assert.ok(
        search.includes(`claims.html#claim-${slug(claim.id)}`),
        `search missing claim: ${claim.id}`,
      );
    }
    for (const proof of model.proofObligations) {
      assert.ok(
        search.includes(`evidence.html#proof-${slug(proof.obligation)}`),
        `search missing proof obligation: ${proof.obligation}`,
      );
    }
    for (const experiment of model.experiments) {
      assert.ok(
        search.includes(`experiments.html#experiment-${slug(experiment.id)}`),
        `search missing experiment: ${experiment.id}`,
      );
    }
    for (const entity of model.architecture) {
      assert.ok(
        search.includes(`architecture.html#${slug(entity.kind)}-${slug(entity.id)}`),
        `search missing architecture entity: ${entity.kind}:${entity.id}`,
      );
    }


    const demonstrated = model.claims.filter((claim) => claim.statusKind === 'demonstrated').length;
    const demonstratedFromAuthority = model.claims.filter(
      (claim) => claim.status === 'Demonstrated' || claim.status.startsWith('Demonstrated '),
    ).length;
    assert.equal(
      demonstrated,
      demonstratedFromAuthority,
      'semantic demonstrated classification must preserve qualified demonstrated statuses',
    );
    assert.ok(
      home.includes(`<strong>${demonstrated}</strong><span>demonstrated claims</span>`),
      'home metric must count every demonstrated status family member',
    );

    for (const claim of model.claims) {
      const anchor = `claim-${slug(claim.id)}`;
      const cardStart = claims.indexOf(`id="${anchor}"`);
      assert.notEqual(cardStart, -1, `claim vanished: ${claim.id}`);
      const cardEnd = claims.indexOf('</article>', cardStart);
      assert.notEqual(cardEnd, -1, `claim card did not terminate: ${claim.id}`);
      const claimCard = claims.slice(cardStart, cardEnd);

      assert.ok(
        claimCard.includes(`class="status status-${claim.statusKind}"`),
        `claim status lost bounded semantic class: ${claim.id}`,
      );
      assert.ok(
        claimCard.includes(`research/claims.md · ${claim.id}`),
        `claim source missing: ${claim.id}`,
      );
      if (claim.statusScope) {
        assert.ok(
          claimCard.includes(escapeHtml(claim.statusScope)),
          `claim status scope missing: ${claim.id}`,
        );
      }
      if (claim.evidenceBoundary) {
        assert.ok(
          claimCard.includes(escapeHtml(claim.evidenceBoundary)),
          `claim evidence boundary missing: ${claim.id}`,
        );
      }
      assert.ok(
        claimCard.includes('<a href="evidence.html">Proof obligation register</a>'),
        `claim evidence route missing: ${claim.id}`,
      );
      if (claim.repositoryRefs.length > 0) {
        for (const path of claim.repositoryRefs) {
          assert.ok(
            claimCard.includes(path),
            `claim referenced source missing from card: ${claim.id}:${path}`,
          );
        }
      }
      assert.match(
        index,
        new RegExp(`claims\\.html#${anchor}`),
        `claim absent from index: ${claim.id}`,
      );
    }

    for (const experiment of model.experiments) {
      const anchor = `experiment-${slug(experiment.id)}`;
      assert.match(
        experiments,
        new RegExp(`id="${anchor}"`),
        `experiment vanished: ${experiment.id}`,
      );
      assert.ok(
        experiments.includes(`class="status status-${experiment.outcomeKind}"`),
        `experiment status lost bounded semantic class: ${experiment.id}`,
      );
      assert.match(
        index,
        new RegExp(`experiments\\.html#${anchor}`),
        `experiment absent from index: ${experiment.id}`,
      );
      for (const path of experiment.repositoryRefs) {
        assert.ok(
          experiments.includes(path),
          `experiment referenced source missing: ${experiment.id}:${path}`,
        );
      }
    }

    for (const proof of model.proofObligations) {
      const anchor = `proof-${slug(proof.obligation)}`;
      assert.ok(
        evidence.includes(`id="${anchor}"`),
        `proof obligation vanished: ${proof.obligation}`,
      );
      assert.ok(
        index.includes(`evidence.html#${anchor}`),
        `proof obligation absent from index: ${proof.obligation}`,
      );
      for (const path of proof.repositoryRefs) {
        assert.ok(
          evidence.includes(path),
          `proof referenced source missing: ${proof.obligation}:${path}`,
        );
      }
    }

    const referenceCounts = new Map<string, number>();
    for (const refs of [
      ...model.claims.map((claim) => claim.repositoryRefs),
      ...model.proofObligations.map((proof) => proof.repositoryRefs),
      ...model.experiments.map((experiment) => experiment.repositoryRefs),
    ]) {
      for (const path of refs) referenceCounts.set(path, (referenceCounts.get(path) ?? 0) + 1);
    }
    const sharedPaths = [...referenceCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([path]) => path);
    assert.ok(sharedPaths.length > 0, 'relational index needs at least one shared source artifact');
    for (const path of sharedPaths) {
      assert.ok(index.includes(path), `shared source relationship missing: ${path}`);
    }
    assert.ok(index.includes('Claim families'), 'claim-family facet missing');
    assert.ok(index.includes('Claim states'), 'claim-state facet missing');
    assert.ok(index.includes('Architecture kinds'), 'architecture-kind facet missing');
    assert.ok(index.includes('Shared source relationships'), 'relational source section missing');

    for (const entity of model.architecture) {
      const anchor = `${slug(entity.kind)}-${slug(entity.id)}`;
      assert.match(
        architecture,
        new RegExp(`id="${anchor}"`),
        `architecture entity vanished: ${entity.kind}:${entity.id}`,
      );
      assert.match(
        index,
        new RegExp(`architecture\\.html#${anchor}`),
        `architecture entity absent from index: ${entity.kind}:${entity.id}`,
      );
    }

    const rendered = [...pages.values()].join('\n');
    for (const phrase of [
      'Executable research prototype',
      'Say exactly what is established.',
      'Green means something specific.',
      'Vocabulary becomes a navigable surface.',
      'Failures teach architecture too.',
      'One corpus, many ways in.',
      'Resolution frontier',
    ]) {
      assert.equal(rendered.includes(phrase), false, `stock site copy returned: ${phrase}`);
    }
    assert.equal(rendered.includes('class="eyebrow"'), false);
    assert.equal(rendered.includes('class="triptych"'), false);

    assert.equal(
      claims.includes('status-demonstrated-for-'),
      false,
      'free-form demonstrated scope must not become a CSS class',
    );
    assert.match(
      siteCss,
      /\.status-safety-constraint \{[\s\S]*?background: var\(--lemon\);[\s\S]*?\}/,
    );
    assert.match(
      siteCss,
      /\.status-unknown,[\s\S]*?\.status-other \{[\s\S]*?background: var\(--cream\);[\s\S]*?\}/,
    );

    for (const [file, html] of pages) {
      const currentLinks = [...html.matchAll(/aria-current="page"/g)];
      assert.equal(currentLinks.length, 1, `exactly one active navigation item required: ${file}`);
      assert.ok(
        html.includes(`href="${file}" aria-current="page"`),
        `active navigation target mismatch: ${file}`,
      );
    }

    const anchorsByPage = new Map<string, Set<string>>();
    for (const [file, html] of pages) {
      anchorsByPage.set(
        file,
        new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? '')),
      );
    }

    for (const [file, html] of pages) {
      for (const hrefMatch of html.matchAll(/href="([^"]+)"/g)) {
        const href = hrefMatch[1] ?? '';
        if (
          href.startsWith('https://') ||
          href.startsWith('http://') ||
          href.startsWith('mailto:') ||
          href === 'site.css'
        ) {
          continue;
        }

        const [targetFileRaw, targetAnchor] = href.split('#');
        const targetFile = targetFileRaw || file;
        assert.ok(pages.has(targetFile), `broken internal page link from ${file}: ${href}`);
        if (targetAnchor) {
          assert.ok(
            anchorsByPage.get(targetFile)?.has(targetAnchor),
            `broken internal anchor from ${file}: ${href}`,
          );
        }
      }
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
