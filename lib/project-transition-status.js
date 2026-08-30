import { evaluateProjectGraph } from './project-graph.js';

function authorityProjection(graph) {
  const authority = graph?.authority?.definition;
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
  return Object.freeze({
    kind:String(authority.kind || ''),
    repository:String(authority.repository || ''),
    revision:String(authority.revision || ''),
    derivation:String(authority.derivation || ''),
  });
}

function lifecycleProjection(lifecycle = {}) {
  return Object.freeze({
    current_stage:String(lifecycle.current_stage || ''),
    next_stage:lifecycle.next_stage == null ? null : String(lifecycle.next_stage),
    condition:String(lifecycle.condition || ''),
    command:lifecycle.command == null ? null : String(lifecycle.command),
    complete:lifecycle.complete === true,
  });
}

function transitionProjection(node) {
  return Object.freeze({
    id:node.id,
    priority:node.priority,
    state:node.state,
    requires:Object.freeze([...node.requires]),
    unmet_requirements:Object.freeze([...node.unmet_requirements]),
    lifecycle:lifecycleProjection(node.lifecycle),
    executor:node.executor,
  });
}

export function projectTransitionStatus(graph) {
  const evaluation = evaluateProjectGraph(graph);
  return Object.freeze({
    project:Object.freeze({
      available:true,
      schema:'project-transition-status-v1',
      project_ref:String(graph?.project_ref || ''),
      authority:authorityProjection(graph),
      complete:evaluation.complete,
      frontier:Object.freeze(evaluation.frontier.map((node) => node.id)),
    }),
    project_transitions:Object.freeze(evaluation.nodes.map(transitionProjection)),
  });
}

export function unavailableProjectTransitionStatus(error) {
  return Object.freeze({
    project:Object.freeze({
      available:false,
      schema:'project-transition-status-v1',
      project_ref:null,
      authority:null,
      complete:null,
      frontier:Object.freeze([]),
      error_code:String(error?.code || 'PROJECT_GRAPH_UNAVAILABLE'),
    }),
    project_transitions:Object.freeze([]),
  });
}