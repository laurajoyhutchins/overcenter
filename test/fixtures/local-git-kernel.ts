import { execFileSync } from 'node:child_process';
import { GitOvercenterKernel, type GitKernelOptions } from '../../src/storage/git-kernel.ts';
export { runCoreLoop } from '../../src/execution/core-loop.ts';

// Local fixtures use the production Git implementation, without a provider remote.
export class LocalGitKernel extends GitOvercenterKernel {
  constructor(repo: string, options: GitKernelOptions = {}) {
    execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
    super(repo, options);
  }

  close(): void {}
}
