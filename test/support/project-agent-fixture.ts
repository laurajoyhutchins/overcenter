import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function fixture(): {
  root: string;
  work: string;
  sourceSha: string;
  postconditionRoot: string;
  postconditionPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-project-agent-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work);

  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'config', 'user.name', 'Overcenter Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'config', 'user.email', 'overcenter-test@local'], {
    stdio: 'ignore',
  });
  writeFileSync(
    join(work, 'task.mjs'),
    "import fs from 'node:fs';\nconst input=fs.readFileSync(process.argv[2],'utf8').trim();\nfs.writeFileSync(process.argv[3],'completed:'+input+'\\n');\n",
  );
  writeFileSync(join(work, 'input.txt'), 'hello\n');
  mkdirSync(join(work, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(work, '.github/workflows/agent-candidate-signal.yml'),
    'trusted fixture producer',
  );
  mkdirSync(join(work, '.overcenter'), { recursive: true });
  writeFileSync(
    join(work, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(
      {
        schema: 'overcenter-source-verification-profile/v2',
        id: 'fixture-baseline',
        protected_paths: ['.github', '.overcenter', 'input.txt'],
        baseline_test_roots: ['test'],
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'feature.txt'), 'feature:base\n');
  execFileSync('git', ['-C', work, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'commit', '-m', 'seed task source'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', remote], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'push', '-u', 'origin', 'main'], { stdio: 'ignore' });

  const sourceSha = git(work, ['rev-parse', 'HEAD']);
  const postconditionRoot = join('/tmp', `overcenter-agent-${randomUUID()}`);
  const postconditionPath = join(postconditionRoot, 'result.txt');
  return { root, work, sourceSha, postconditionRoot, postconditionPath };
}

export function commandContext(sourceSha: string, runId = 9001) {
  return {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    command_source_sha: sourceSha,
    command_run_id: runId,
    command_run_attempt: 2,
  };
}
