import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface TcbReport {
  schema: 'overcenter-tcb-report';
  schema_version: 1;
  obligations: Array<{ id: string }>;
  reconciliation: {
    properties: Array<{ scope: string; classification: string }>;
    compositions: Array<{ scope: string; classification: string }>;
  } | null;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`TCB_REMEDIATION_OPTION_REQUIRED:${name}`);
  return value;
}

function readReport(path: string): TcbReport {
  if (!existsSync(path)) throw new Error('TCB_REMEDIATION_REPORT_MISSING');
  const value = JSON.parse(readFileSync(path, 'utf8')) as TcbReport;
  if (value.schema !== 'overcenter-tcb-report' || value.schema_version !== 1) {
    throw new Error('TCB_REMEDIATION_REPORT_INVALID');
  }
  return value;
}

const root = resolve(option('--root'));
const findingId = option('--finding');
const baselineSha = option('--baseline').toLowerCase();
if (!findingId.startsWith('tcb:')) throw new Error('TCB_REMEDIATION_FINDING_INVALID');
if (!/^[0-9a-f]{40}$/.test(baselineSha)) throw new Error('TCB_REMEDIATION_BASELINE_INVALID');

const scratch = mkdtempSync(join(tmpdir(), 'overcenter-tcb-remediation-'));
try {
  const reportPath = join(scratch, 'report.json');
  const trustedScript = resolve(dirname(fileURLToPath(import.meta.url)), 'report-tcb.ts');
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      trustedScript,
      '--baseline',
      baselineSha,
      '--output',
      reportPath,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const report = readReport(reportPath);

  const baselineRaw = execFileSync(
    'git',
    ['-C', root, 'show', `${baselineSha}:.overcenter/tcb-obligations.json`],
    { encoding: 'utf8' },
  );
  const baseline = JSON.parse(baselineRaw) as { obligations?: Array<{ id?: unknown }> };
  const baselineIds = new Set(
    (baseline.obligations ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  if (!baselineIds.has(findingId)) throw new Error('TCB_REMEDIATION_FINDING_NOT_IN_BASELINE');

  const finalIds = new Set(report.obligations.map((item) => item.id));
  for (const delta of [
    ...(report.reconciliation?.properties ?? []),
    ...(report.reconciliation?.compositions ?? []),
  ]) {
    if (delta.classification === 'architectural-growth') {
      finalIds.add(`tcb:growth:${delta.scope}`);
    }
  }

  if (finalIds.has(findingId)) throw new Error('TCB_REMEDIATION_FINDING_STILL_PRESENT');
  const introduced = [...finalIds].filter((id) => !baselineIds.has(id)).sort();
  if (introduced.length > 0) {
    throw new Error(`TCB_REMEDIATION_NEW_DEBT:${introduced.join(',')}`);
  }
  if (run.status !== 0) {
    throw new Error(
      `TCB_REMEDIATION_REPORT_FAILED:${String(run.stderr || run.stdout || '').trim()}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      schema: 'overcenter-tcb-remediation-verification/v1',
      finding_id: findingId,
      baseline_sha: baselineSha,
      remaining_findings: [...finalIds].sort(),
    })}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
