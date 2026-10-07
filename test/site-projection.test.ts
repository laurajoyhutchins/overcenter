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
    const experiments = pages.get('experiments.html') ?? '';
    const architecture = pages.get('architecture.html') ?? '';
    const index = pages.get('index-of-terms.html') ?? '';

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
    }

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
