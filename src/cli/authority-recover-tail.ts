import { recoverInvalidDoneClaimTail } from '../storage/git-authority-recovery.ts';

const authorityRef = process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state';
const remote = process.env.OVERCENTER_PROJECT_REMOTE ?? 'origin';

const result = recoverInvalidDoneClaimTail(process.cwd(), {
  ref: authorityRef,
  remote,
});

console.log(JSON.stringify(result, null, 2));
