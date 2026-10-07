import { readFile, realpath } from 'node:fs/promises';
import { OvercenterKernel } from '../../src/authority/kernel.ts';
import type { ExecutionPermit } from '../../src/model.ts';
import { dispatchAdmittedEffect } from '../../src/providers/effect-dispatch.ts';
import {
  createPagesGitPush,
  type PagesEffectContext,
} from '../../src/providers/github/pages-effect.ts';
import { pagesGitText, readPagesGitManifest } from '../../src/providers/github/pages-git.ts';

// Inputs belong to the operator. This harness never defines work, claims it,
// manufactures a witness, or configures Pages.
const [mode, db, permitFile, destinationFile, objectRepo, readbackRepo] = process.argv.slice(2);
if (
  !['push', 'recover'].includes(mode ?? '') ||
  !db ||
  !permitFile ||
  !destinationFile ||
  !objectRepo ||
  !readbackRepo
) {
  throw new Error(
    'usage: experiment.ts push|recover DB PERMIT_JSON DESTINATION_JSON OBJECT_REPO READBACK_REPO',
  );
}
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
if ((await realpath(objectRepo)) === (await realpath(readbackRepo)))
  throw new Error('PAGES_INDEPENDENT_READBACK_REQUIRED');
const permit = JSON.parse(await readFile(permitFile, 'utf8')) as ExecutionPermit;
const destination = JSON.parse(
  await readFile(destinationFile, 'utf8'),
) as PagesEffectContext['destination'];
const kernel = new OvercenterKernel(db, {
  githubToken: token,
  observationContext: {
    pages: {
      readGitTree: async (p) => {
        // An independently populated provider mirror, never the generator's store.
        if (
          pagesGitText(readbackRepo, ['rev-parse', `${p.publication_sha}^{tree}`]) !==
          p.publication_tree_sha
        ) {
          throw new Error('PAGES_REMOTE_TREE_MISMATCH');
        }
        return readPagesGitManifest(readbackRepo, p.publication_tree_sha, p.limits);
      },
    },
  },
});
try {
  if (mode === 'push') {
    if (!process.env.GIT_ASKPASS) throw new Error('PAGES_EXTERNAL_GIT_CREDENTIAL_REQUIRED');
    await dispatchAdmittedEffect(kernel, permit, {
      pages: {
        token,
        destination,
        object_repo: objectRepo,
        pushWithExpectedHead: createPagesGitPush(
          objectRepo,
          `https://github.com/${destination.repository_full_name}.git`,
          {
            GIT_ASKPASS: process.env.GIT_ASKPASS,
            GITHUB_TOKEN: token,
          },
        ),
      },
    });
    // Deliberately exit before settlement: the next process only observes.
    process.stdout.write(
      JSON.stringify({ phase: 'reserved-push-returned', settlement: 'unobserved' }) + '\n',
    );
  } else {
    kernel.recoverInterrupted(permit);
    process.stdout.write(JSON.stringify(await kernel.resolveAsync(permit)) + '\n');
  }
} finally {
  kernel.close();
}
