import { performGitHubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';

type Callback = () => void;

function invoke(callback: Callback): void {
  callback();
}

invoke(() => {
  void performGitHubCommitStatusEffect(null as never, null as never, {
    token: 'fixture',
  });
});
