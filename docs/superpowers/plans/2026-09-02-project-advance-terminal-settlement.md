# project.advance terminal settlement fix

## Goal

Returning `execution_result` for one agent session must settle that session and stop. It must never allocate or advance a fresh run in the same call, because that can acquire unrelated READY project work.

## Plan

1. Add a regression to `lib/project-agent-session-boundary-regression.js` proving that a project-scoped resumed run with `execution_result: completed` calls finish exactly once, does not call `runs.start`, does not call `advance.advance`, and returns the finished run without a resumable continuation.
2. Verify the regression fails against the current host behavior.
3. Change `lib/project-advance-overcenter-host.js` so `execution_result` is a terminal branch: finish the existing run, validate the returned run identity, and return that settlement result with `resume_ref: null`.
4. Update the `project.advance` semantic description to state that settlement ends the current session and selecting more work requires a separate call.
5. Run the repository/CI regression suite and runtime regression surface, inspect the PR diff, merge to `dev`, then promote the verified development revision through Overcenter.
6. Re-run a production semantic settlement/readback check to prove no new run or unrelated lease is created.
