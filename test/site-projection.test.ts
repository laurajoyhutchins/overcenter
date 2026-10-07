import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSite } from '../examples/site/build.ts';
import { PAGE_FILES, slug } from '../examples/site/render.ts';

test('site projection conserves source records and internal links', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'overcenter-site-'));
  try {
    const model = await buildSite({ outDir });
    const pages = new Map<string, string>();
    for (const file of PAGE_FILES) {
      pages.set(file, await readFile(join(outDir, file), 'utf8'));
    }

    const claims = pages.get('claims.html') ?? '';
    const experiments = pages.get('experiments.html') ?? '';
    const architecture = pages.get('architecture.html') ?? '';
    const index = pages.get('index-of-terms.html') ?? '';

    for (const claim of model.claims) {
      const anchor = `claim-${slug(claim.id)}`;
      assert.match(claims, new RegExp(`id="${anchor}"`), `claim vanished: ${claim.id}`);
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
