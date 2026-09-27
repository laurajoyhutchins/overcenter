import { normalizeObligation, type ObligationInput } from './facts.ts';
import type { ProjectGraphProducer } from './project-graph.ts';
import type { RepositorySnapshot } from '../evidence/repository-snapshot.ts';
import {
  SOURCE_TASK_SCHEMA,
  validateSourceTaskPacket,
} from '../source/source-obligation.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const PROJECT_GOAL_SCHEMA = 'overcenter-project-goal/v1' as const;
export const PROJECT_GOAL_PATH = '.overcenter/project-goal.json' as const;
export const PROJECT_GOAL_SATISFACTION_SCHEMA =
  'overcenter-project-goal-satisfaction/v1' as const;
export const PROJECT_GOAL_SATISFACTION_PATH =
  '.overcenter/project-goal-satisfaction.json' as const;
export const PROJECT_GOAL_PREFIX = 'project-goal:' as const;
export const PROJECT_GOAL_ITERATION_SCHEMA =
  'overcenter-project-goal-iteration/v1' as const;

interface ProjectGoal {
  schema: typeof PROJECT_GOAL_SCHEMA;
  id: string;
  objective: string;
  writable_paths: string[];
  writable_trees?: string[];
}

interface ProjectGoalSatisfaction {
  schema: typeof PROJECT_GOAL_SATISFACTION_SCHEMA;
  goal_id: string;
  state: 'satisfied';
  evidence: Record<string, unknown>;
}

function parseJson(bytes: Buffer, error: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(error);
  }
}

function validateGoal(value: unknown): ProjectGoal {
  if (!isData(value)) throw new Error('PROJECT_GOAL_INVALID');
  assertExactKeys(
    value,
    ['schema', 'id', 'objective', 'writable_paths'],
    ['writable_trees'],
    'PROJECT_GOAL_INVALID',
  );
  if (value.schema !== PROJECT_GOAL_SCHEMA) {
    throw new Error('PROJECT_GOAL_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.id, 'PROJECT_GOAL_ID_INVALID');
  if (!value.id.startsWith(PROJECT_GOAL_PREFIX)) {
    throw new Error('PROJECT_GOAL_ID_NAMESPACE_INVALID');
  }
  assertNonEmptyString(value.objective, 'PROJECT_GOAL_OBJECTIVE_INVALID');

  const task = validateSourceTaskPacket({
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: value.objective,
    writable_paths: value.writable_paths,
    ...(value.writable_trees === undefined ? {} : { writable_trees: value.writable_trees }),
  });
  return {
    schema: PROJECT_GOAL_SCHEMA,
    id: value.id,
    objective: task.objective,
    writable_paths: task.writable_paths,
    ...(task.writable_trees ? { writable_trees: task.writable_trees } : {}),
  };
}

function validateSatisfaction(value: unknown): ProjectGoalSatisfaction {
  if (!isData(value)) throw new Error('PROJECT_GOAL_SATISFACTION_INVALID');
  assertExactKeys(
    value,
    ['schema', 'goal_id', 'state', 'evidence'],
    [],
    'PROJECT_GOAL_SATISFACTION_INVALID',
  );
  if (value.schema !== PROJECT_GOAL_SATISFACTION_SCHEMA) {
    throw new Error('PROJECT_GOAL_SATISFACTION_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.goal_id, 'PROJECT_GOAL_SATISFACTION_GOAL_INVALID');
  if (value.state !== 'satisfied') {
    throw new Error('PROJECT_GOAL_SATISFACTION_STATE_INVALID');
  }
  if (!isData(value.evidence) || Object.keys(value.evidence).length === 0) {
    throw new Error('PROJECT_GOAL_SATISFACTION_EVIDENCE_INVALID');
  }
  return {
    schema: PROJECT_GOAL_SATISFACTION_SCHEMA,
    goal_id: value.goal_id,
    state: 'satisfied',
    evidence: structuredClone(value.evidence),
  };
}

export function compileProjectGoal(
  goalValue: unknown,
  projectSourceSha: string,
  satisfactionValue: unknown | null = null,
): ObligationInput[] {
  const goal = validateGoal(goalValue);
  if (!/^[0-9a-f]{40}$/.test(projectSourceSha)) {
    throw new Error('PROJECT_GOAL_SOURCE_INVALID');
  }

  if (satisfactionValue !== null) {
    const satisfaction = validateSatisfaction(satisfactionValue);
    if (satisfaction.goal_id !== goal.id) {
      throw new Error('PROJECT_GOAL_SATISFACTION_GOAL_MISMATCH');
    }
    return [];
  }

  return [
    normalizeObligation({
      id: goal.id,
      packet: validateSourceTaskPacket({
        schema: SOURCE_TASK_SCHEMA,
        kind: 'source-change',
        objective: goal.objective,
        writable_paths: goal.writable_paths,
        ...(goal.writable_trees ? { writable_trees: goal.writable_trees } : {}),
        context: {
          schema: PROJECT_GOAL_ITERATION_SCHEMA,
          project_source_sha: projectSourceSha,
        },
      }),
      postcondition: { verifier: 'source-integration/v1' },
    }),
  ];
}

export const projectGoalGraphProducer: ProjectGraphProducer = Object.freeze({
  id: 'project-goal',
  input_paths: [PROJECT_GOAL_PATH],
  managed_prefixes: [PROJECT_GOAL_PREFIX],
  produce(snapshot: RepositorySnapshot) {
    const goal = parseJson(snapshot.bytes(PROJECT_GOAL_PATH), 'PROJECT_GOAL_JSON_INVALID');
    const satisfactionBytes = snapshot.optionalBytes(PROJECT_GOAL_SATISFACTION_PATH);
    const satisfaction =
      satisfactionBytes === null
        ? null
        : parseJson(satisfactionBytes, 'PROJECT_GOAL_SATISFACTION_JSON_INVALID');
    return compileProjectGoal(goal, snapshot.revision, satisfaction);
  },
});
