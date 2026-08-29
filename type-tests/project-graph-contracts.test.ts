import {
  normalizeProjectExecutor,
  normalizeProjectPhaseBindings,
  normalizeProjectPhaseInput,
} from '../src/semantic/project-graph-contracts.js';
import type { Executor, PhaseBindings, PhaseInputSource } from '../src/semantic/project-graph-types.js';

type Fail = (code: string, message: string, details?: unknown) => never;
declare const fail: Fail;

const operator: Executor = normalizeProjectExecutor(
  { kind: 'operator', command: 'github.apply_changeset' },
  'node-a',
  fail,
);
const agent: Executor = normalizeProjectExecutor(
  { kind: 'agent', role: 'implementation', skill: 'test-driven-development' },
  'node-b',
  fail,
);
void operator;
void agent;

const phaseInput: Readonly<Record<string, PhaseInputSource>> = normalizeProjectPhaseInput(
  {
    repository: { from: 'transition.repository' },
    retry_limit: { literal: 2 },
  },
  'node-a',
  'ACQUIRE',
  fail,
);
void phaseInput;

const phaseBindings: PhaseBindings = normalizeProjectPhaseBindings(
  {
    ACQUIRE: {
      primitive: 'work.claim',
      evidence: ['lease'],
      input: { repository: { from: 'transition.repository' } },
    },
  },
  'node-a',
  fail,
);
void phaseBindings;