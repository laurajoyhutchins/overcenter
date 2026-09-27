import { performGithubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';

type Callback = () => void;

function invoke(callback: Callback): void {
  callback();
}

invoke(() => {
  void performGithubCommitStatusEffect(null as never, null as never, {
    token: 'fixture',
  });
});
