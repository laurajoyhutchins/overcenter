import { performGitHubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';

interface DynamicEffect {
  run(): void;
}

declare const effect: DynamicEffect;
void performGitHubCommitStatusEffect;
effect.run();
