import { parseCanonicalCommand } from '../src/semantic/command-contracts.js';
import type { CanonicalCommand } from '../src/semantic/command-contracts.js';
import type { GitSha, IdempotencyKey, LeaseId, RunId, WorkRef } from '../src/semantic/semantic-identities.js';
import type { Executor, PhaseInputSource, ProjectNodeState } from '../src/semantic/project-graph-types.js';

declare const runId: RunId;
declare const leaseId: LeaseId;
declare const workRef: WorkRef;
declare const gitSha: GitSha;
declare const idempotencyKey: IdempotencyKey;

const acceptRunId = (_value: RunId) => undefined;
const acceptLeaseId = (_value: LeaseId) => undefined;
const acceptWorkRef = (_value: WorkRef) => undefined;
const acceptGitSha = (_value: GitSha) => undefined;
const acceptIdempotencyKey = (_value: IdempotencyKey) => undefined;

acceptRunId(runId);
acceptLeaseId(leaseId);
acceptWorkRef(workRef);
acceptGitSha(gitSha);
acceptIdempotencyKey(idempotencyKey);

// @ts-expect-error LeaseId must not be accepted where RunId is required.
acceptRunId(leaseId);
// @ts-expect-error WorkRef must not be accepted where GitSha is required.
acceptGitSha(workRef);

const claimCommand: CanonicalCommand = parseCanonicalCommand('work.claim');
void claimCommand;
// @ts-expect-error Unvalidated strings must not enter the typed semantic command surface.
const invalidCommand: CanonicalCommand = 'work.claim.extra';
void invalidCommand;

const operator: Executor = { kind: 'operator', command: 'github.apply_changeset' };
const agent: Executor = { kind: 'agent', role: 'implementation', skill: 'test-driven-development' };
void operator;
void agent;
// @ts-expect-error Operator executors cannot carry agent-only fields.
const mixedExecutor: Executor = { kind: 'operator', command: 'github.apply_changeset', role: 'implementation', skill: 'test-driven-development' };
void mixedExecutor;

const fromInput: PhaseInputSource = { from: 'transition.repository' };
const literalInput: PhaseInputSource = { literal: 42 };
void fromInput;
void literalInput;
// @ts-expect-error A phase input source must choose from or literal, never both.
const ambiguousInput: PhaseInputSource = { from: 'transition.repository', literal: 42 };
void ambiguousInput;

const state: ProjectNodeState = 'READY';
void state;
// @ts-expect-error Project node states are a closed semantic set.
const invalidState: ProjectNodeState = 'RUNNING';
void invalidState;