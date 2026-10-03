import { execFileSync } from 'node:child_process';
import { OvercenterKernel, type KernelStorageOptions } from '../../src/authority/kernel.ts';
export { runCoreLoop } from '../../src/execution/core-loop.ts';

// Local fixtures use the production Git implementation, without a provider remote.
export class LocalGitKernel extends OvercenterKernel {
  constructor(repo: string, options: KernelStorageOptions = {}) {
    execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
    super(repo, options);
  }
}
