import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditRepository } from './test-audit-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd:root, encoding:'utf8' }).trim();
const audit = await auditRepository({ root, revision });
console.log(JSON.stringify(audit, null, 2));
if (audit.unresolved_count !== 0) process.exitCode = 1;
