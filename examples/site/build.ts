import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSiteModel, type SiteModel } from './model.ts';
import { generators, PAGE_FILES } from './render.ts';

export interface BuildSiteOptions {
  root?: string;
  outDir?: string;
}

const SITE_ROOT = 'https://laurajoyhutchins.github.io/overcenter/';

function renderSitemap(): string {
  const urls = PAGE_FILES.map((file) => {
    const location = file === 'index.html' ? SITE_ROOT : `${SITE_ROOT}${file}`;
    return `  <url><loc>${location}</loc></url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
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
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSite();
}
