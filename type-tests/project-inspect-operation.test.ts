import type {
  ProjectInspectIntent,
  ProjectInspectPorts,
  ProjectInspection,
} from '../src/semantic/project-inspect-operation';
import { inspectProject } from '../src/semantic/project-inspect-operation';

const intent: ProjectInspectIntent = { project_ref: 'github:laurajoyhutchins/overcenter' };

const ports: ProjectInspectPorts = {
  async inspectProject(projectRef) {
    return {
      project_ref: projectRef,
      authority_revision: 'ae099c41ac1c27c77d251bac73d2fcff72a3e1f4',
      complete: false,
      frontier: ['compact-agent-semantic-surface'],
    };
  },
};

const result: Promise<ProjectInspection> = inspectProject(intent, ports);
void result;

// @ts-expect-error ordinary project inspection must not accept run choreography
inspectProject({ project_ref: intent.project_ref, run_id: 'caller-supplied' }, ports);