import { writeFileSync } from 'node:fs';
import { reportSourceTransaction } from '../src/source/transaction-report.ts';

const [runId, output] = process.argv.slice(2);
if (!runId) throw new Error('SOURCE_TRANSACTION_REPORT_RUN_REQUIRED');
const report = reportSourceTransaction(process.cwd(), runId, {
  requireSettled: true,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  remote: process.env.OVERCENTER_PROJECT_REMOTE ?? 'origin',
  authorityRef: process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state',
});
const bytes = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(output, bytes);
else process.stdout.write(bytes);
