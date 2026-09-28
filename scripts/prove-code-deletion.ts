#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { API } from 'typescript/unstable/sync';
import {
  isClassDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isVariableStatement,
  type Node,
} from 'typescript/unstable/ast';

import { repositoryRelativePath } from '../src/analysis/typescript-runtime.ts';
import {
  buildCounterfactualDeletionProof,
  parseCodeSymbolSelector,
  selectCounterfactualDeletion,
  type CounterfactualEvidenceStep,
} from '../src/repository/code-deletion-proof.ts';
import { buildCodeDeletionHandoff } from '../src/repository/code-deletion-handoff.ts';
import type { CodeWitnessReport } from '../src/repository/code-witness.ts';

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('CODE_DELETION_ARGUMENT_VALUE_REQUIRED:' + name);
  }
  return value;
}

function exactSourceRevision(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const expected = process.env.SOURCE_SHA;
  if (expected && expected !== head) {
    throw new Error('CODE_DELETION_SOURCE_REVISION_MISMATCH:' + expected + ':' + head);
  }
  return head;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function nodeName(node: Node): string | null {
  const named = node as Node & { name?: Node };
  return named.name && isIdentifier(named.name) ? named.name.text : null;
}

function deletionRange(
  root: string,
  path: string,
  symbol: string,
): {
  start: number;
  end: number;
  source: string;
} {
  const absolute = resolve(root, path);
  const sourceText = readFileSync(absolute, 'utf8');
  const api = new API({ cwd: root });
  const snapshot = api.updateSnapshot({ openFiles: [absolute] });
  try {
    const project = snapshot.getDefaultProjectForFile(absolute);
    const source = project?.program.getSourceFile(absolute);
    if (!source) throw new Error('CODE_DELETION_SOURCE_UNAVAILABLE:' + path);

    for (const statement of source.statements) {
      if (
        (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
        nodeName(statement) === symbol
      ) {
        let end = statement.getEnd();
        if (sourceText.slice(end, end + 2) === '\r\n') end += 2;
        else if (sourceText[end] === '\n') end += 1;
        return { start: statement.getFullStart(), end, source: sourceText };
      }

      if (!isVariableStatement(statement)) continue;
      const namedCallable = statement.declarationList.declarations.some(
        (declaration) => isIdentifier(declaration.name) && declaration.name.text === symbol,
      );
      if (namedCallable) {
        throw new Error('CODE_DELETION_CALLABLE_VARIABLE_UNSUPPORTED:' + path + '#' + symbol);
      }
    }
  } finally {
    snapshot.dispose();
    api.close();
  }
  throw new Error('CODE_DELETION_DECLARATION_NOT_FOUND:' + path + '#' + symbol);
}

function runEvidence(worktree: string, candidateRevision: string): CounterfactualEvidenceStep[] {
  const commands: Array<{
    name: CounterfactualEvidenceStep['name'];
    command: string;
    args: string[];
  }> = [
    { name: 'lint', command: 'npm', args: ['run', 'lint'] },
    { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
    {
      name: 'architecture-reconciliation',
      command: 'npm',
      args: ['run', 'check:architecture-reconciliation'],
    },
    { name: 'trusted-computing-base', command: 'npm', args: ['run', 'check:tcb'] },
    {
      name: 'adapter-diagnosability',
      command: 'npm',
      args: ['run', 'check:adapter-diagnosability'],
    },
    {
      name: 'experiment-statistics',
      command: 'npm',
      args: ['run', 'check:experiment-statistics'],
    },
    { name: 'code-witness-analysis', command: 'npm', args: ['run', 'check:code-witnesses'] },
    { name: 'unit-tests', command: 'npm', args: ['run', 'test:unit'] },
  ];
  const evidence: CounterfactualEvidenceStep[] = [];
  for (const item of commands) {
    const result = spawnSync(item.command, item.args, {
      cwd: worktree,
      env: { ...process.env, SOURCE_SHA: candidateRevision },
      stdio: 'inherit',
    });
    const passed = result.status === 0 && !result.error;
    evidence.push({ name: item.name, passed });
    if (!passed) break;
  }
  return evidence;
}

const root = process.cwd();
const selector = argValue('--symbol');
if (!selector) throw new Error('CODE_DELETION_SYMBOL_REQUIRED');
const parsed = parseCodeSymbolSelector(selector);
const output = argValue('--output');
const outputPath = output ? resolve(root, output) : null;
const handoffOutput = argValue('--handoff');
const handoffOutputPath = handoffOutput ? resolve(root, handoffOutput) : null;
const sourceRevision = exactSourceRevision();
const temporary = mkdtempSync(join(tmpdir(), 'overcenter-code-deletion-'));
const reportPath = join(temporary, 'witness-report.json');
const worktree = join(temporary, 'worktree');

try {
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/report-code-witnesses.ts', '--output', reportPath],
    {
      cwd: root,
      env: { ...process.env, SOURCE_SHA: sourceRevision },
      stdio: 'inherit',
    },
  );
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as CodeWitnessReport;
  selectCounterfactualDeletion(report, sourceRevision, selector);

  const range = deletionRange(root, parsed.path, parsed.symbol);
  const candidateSource = range.source.slice(0, range.start) + range.source.slice(range.end);
  if (candidateSource === range.source) throw new Error('CODE_DELETION_NO_SOURCE_CHANGE');

  execFileSync('git', ['worktree', 'add', '--detach', worktree, sourceRevision], {
    cwd: root,
    stdio: 'inherit',
  });
  writeFileSync(resolve(worktree, parsed.path), candidateSource);
  execFileSync('git', ['add', '--', parsed.path], { cwd: worktree, stdio: 'inherit' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Overcenter',
      '-c',
      'user.email=overcenter@invalid',
      'commit',
      '--no-gpg-sign',
      '-m',
      'Counterfactual delete ' + selector,
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
      stdio: 'inherit',
    },
  );
  const candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktree,
    encoding: 'utf8',
  }).trim();
  const changedPaths = execFileSync(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', candidateRevision],
    { cwd: worktree, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((path) => repositoryRelativePath(resolve(worktree, path), worktree));
  if (changedPaths.length !== 1 || changedPaths[0] !== parsed.path) {
    throw new Error('CODE_DELETION_CANDIDATE_SCOPE_INVALID:' + changedPaths.join(','));
  }

  const rootModules = resolve(root, 'node_modules');
  if (!existsSync(rootModules)) throw new Error('CODE_DELETION_NODE_MODULES_REQUIRED');
  symlinkSync(rootModules, resolve(worktree, 'node_modules'), 'dir');

  const evidence = runEvidence(worktree, candidateRevision);
  const proof = buildCounterfactualDeletionProof({
    source_revision: sourceRevision,
    candidate_revision: candidateRevision,
    selector,
    source_sha256: sha256(range.source),
    candidate_source_sha256: sha256(candidateSource),
    evidence,
  });
  const serialized = JSON.stringify(proof, null, 2) + '\n';
  if (outputPath) writeFileSync(outputPath, serialized);
  else process.stdout.write(serialized);

  if (proof.status === 'deterministic-evidence-preserved' && handoffOutputPath) {
    const handoff = buildCodeDeletionHandoff(proof, candidateSource);
    writeFileSync(handoffOutputPath, JSON.stringify(handoff, null, 2) + '\n');
  }

  if (proof.status !== 'deterministic-evidence-preserved') process.exitCode = 1;
} finally {
  if (existsSync(worktree)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: root,
        stdio: 'ignore',
      });
    } catch {
      // The temporary directory cleanup below remains authoritative.
    }
  }
  rmSync(temporary, { recursive: true, force: true });
}
