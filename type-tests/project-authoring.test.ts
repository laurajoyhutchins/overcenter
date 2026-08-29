import { normalizeProjectDefinitionIntent } from '../src/semantic/project-authoring.js';
import type { ProjectDefinitionIntent } from '../src/semantic/project-authoring.js';

const valid: ProjectDefinitionIntent = normalizeProjectDefinitionIntent({
  project_ref: 'github:owner/repo',
  transitions: [
    {
      id: 'first-transition',
      priority: 10,
      requires: [],
      executor: { kind: 'agent', role: 'implementation', skill: 'test-driven-development' },
    },
  ],
});
void valid;

// @ts-expect-error Runtime lifecycle state is not semantic definition truth.
const invalidLifecycle: ProjectDefinitionIntent = { project_ref: 'github:owner/repo', transitions: [], lifecycle: {} };
void invalidLifecycle;