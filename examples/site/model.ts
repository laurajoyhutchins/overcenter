import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Claim {
  id: string;
  title: string;
  family: string;
  status: string;
  statement: string;
}

export interface ProofObligation {
  obligation: string;
  implementation: string;
  localAdversarial: string;
  formal: string;
  liveProvider: string;
  boundary: string;
}

export interface Experiment {
  id: string;
  question: string;
  claim: string;
  outcome: string;
  summary: string;
  evidenceStatus: string;
  evaluatedRevision?: string;
}

export interface ArchitectureEntity {
  kind: string;
  id: string;
}

export interface SiteModel {
  thesis: string;
  coreLoop: string;
  claims: Claim[];
  proofObligations: ProofObligation[];
  experiments: Experiment[];
  architecture: ArchitectureEntity[];
}

interface ExperimentRegistry {
  entries: Array<{
    id: string;
    question: string;
    claim: string;
    evidence?: {
      status?: string;
      evaluated_revision?: string;
    };
    outcome?: {
      state?: string;
      summary?: string;
    };
  }>;
}

const ARCHITECTURE_TABLES = [
  'authority',
  'effect',
  'obligation',
  'evidence',
  'capability',
  'assurance_property',
  'artifact',
  'symbol',
  'principal',
] as const;

async function read(root: string, path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

function extractReadmeProjection(readme: string): { thesis: string; coreLoop: string } {
  const thesisMatch = readme.match(/^>\s+(.+)$/m);
  const coreLoopMatch = readme.match(/```text\n([\s\S]*?)\n```/);
  if (!thesisMatch?.[1]) throw new Error('SITE_README_THESIS_MISSING');
  if (!coreLoopMatch?.[1]) throw new Error('SITE_README_CORE_LOOP_MISSING');
  return {
    thesis: thesisMatch[1].trim(),
    coreLoop: coreLoopMatch[1].trim(),
  };
}

function extractClaimStatement(lines: string[]): string {
  const marker = lines.findIndex((line) => line.trim() === '**Claim:**');
  if (marker >= 0) {
    const quoted: string[] = [];
    for (const line of lines.slice(marker + 1)) {
      if (line.startsWith('> ')) {
        quoted.push(line.slice(2).trim());
        continue;
      }
      if (quoted.length > 0 && line.trim() !== '') break;
    }
    if (quoted.length > 0) return quoted.join(' ');
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed &&
      !trimmed.startsWith('**Status:**') &&
      !trimmed.startsWith('```') &&
      !trimmed.startsWith('>')
    ) {
      return trimmed.replaceAll('**', '');
    }
  }
  return 'See the canonical claim record for scope and evidence.';
}

function parseClaims(markdown: string): Claim[] {
  const lines = markdown.split(/\r?\n/);
  const claims: Claim[] = [];
  let family = 'Unclassified';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const familyMatch = line.match(/^##\s+\d+\.\s+(.+)$/);
    if (familyMatch?.[1]) {
      family = familyMatch[1].trim();
      continue;
    }

    const claimMatch = line.match(/^###\s+([A-Z]\d+)\.\s+(.+)$/);
    if (!claimMatch?.[1] || !claimMatch[2]) continue;

    const section: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor] ?? '';
      if (/^#{2,3}\s+/.test(candidate)) break;
      section.push(candidate);
      cursor += 1;
    }

    const statusLine = section.find((candidate) => candidate.startsWith('**Status:**'));
    const status = statusLine?.replace('**Status:**', '').trim().replace(/\.$/, '');
    if (!status) throw new Error(`SITE_CLAIM_STATUS_MISSING:${claimMatch[1]}`);

    claims.push({
      id: claimMatch[1],
      title: claimMatch[2].trim(),
      family,
      status,
      statement: extractClaimStatement(section),
    });
    index = cursor - 1;
  }

  if (claims.length === 0) throw new Error('SITE_CLAIMS_EMPTY');
  return claims;
}

function splitMarkdownRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function parseProofObligations(markdown: string): ProofObligation[] {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === '## Current obligation map');
  if (heading < 0) throw new Error('SITE_PROOF_OBLIGATION_MAP_MISSING');

  const rows: ProofObligation[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    const cells = splitMarkdownRow(line);
    if (
      cells.length !== 6 ||
      cells[0] === 'Obligation' ||
      cells.every((cell) => /^[-: ]+$/.test(cell))
    ) {
      continue;
    }
    rows.push({
      obligation: cells[0] ?? '',
      implementation: cells[1] ?? '',
      localAdversarial: cells[2] ?? '',
      formal: cells[3] ?? '',
      liveProvider: cells[4] ?? '',
      boundary: cells[5] ?? '',
    });
  }

  if (rows.length === 0) throw new Error('SITE_PROOF_OBLIGATIONS_EMPTY');
  return rows;
}

function collectSqlEntityIds(sql: string, table: string): string[] {
  const result = new Set<string>();
  const insert = new RegExp(
    `INSERT INTO\\s+${table}\\s*\\([^)]*\\)\\s*VALUES\\s*([\\s\\S]*?);`,
    'gi',
  );

  for (const match of sql.matchAll(insert)) {
    const valuesBlock = match[1];
    if (!valuesBlock) continue;
    for (const tuple of valuesBlock.matchAll(/\(([^()]*)\)/g)) {
      const firstString = tuple[1]?.match(/'((?:''|[^'])*)'/)?.[1];
      if (firstString) result.add(firstString.replaceAll("''", "'"));
    }
  }
  return [...result].sort();
}

function parseArchitecture(logicSql: string, physicsSql: string): ArchitectureEntity[] {
  const sql = `${logicSql}\n${physicsSql}`;
  const entities = ARCHITECTURE_TABLES.flatMap((kind) =>
    collectSqlEntityIds(sql, kind).map((id) => ({ kind, id })),
  );
  if (entities.length === 0) throw new Error('SITE_ARCHITECTURE_EMPTY');
  return entities;
}

function parseExperiments(registryJson: string): Experiment[] {
  const registry = JSON.parse(registryJson) as ExperimentRegistry;
  if (!Array.isArray(registry.entries)) throw new Error('SITE_EXPERIMENT_REGISTRY_INVALID');

  return registry.entries
    .map((entry) => ({
      id: entry.id,
      question: entry.question,
      claim: entry.claim,
      outcome: entry.outcome?.state ?? 'unknown',
      summary: entry.outcome?.summary ?? '',
      evidenceStatus: entry.evidence?.status ?? 'unknown',
      ...(entry.evidence?.evaluated_revision
        ? { evaluatedRevision: entry.evidence.evaluated_revision }
        : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadSiteModel(root = process.cwd()): Promise<SiteModel> {
  const [readme, claims, proofObligations, logicSql, physicsSql, experimentRegistry] =
    await Promise.all([
      read(root, 'README.md'),
      read(root, 'research/claims.md'),
      read(root, 'research/proof-obligations.md'),
      read(root, 'architecture/logic.sql'),
      read(root, 'architecture/physics.sql'),
      read(root, 'experiments/registry.json'),
    ]);

  const readmeProjection = extractReadmeProjection(readme);
  return {
    ...readmeProjection,
    claims: parseClaims(claims),
    proofObligations: parseProofObligations(proofObligations),
    experiments: parseExperiments(experimentRegistry),
    architecture: parseArchitecture(logicSql, physicsSql),
  };
}
