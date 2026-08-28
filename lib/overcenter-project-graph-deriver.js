export const OVERCENTER_PROJECT_GRAPH_DERIVATION = 'overcenter-project-graph-v1';
export const OVERCENTER_PROJECT_DEFINITION_PATH = '.overcenter/definitions/target-architecture.json';

export function deriveOvercenterProjectGraph() {
  const error = new Error('Overcenter project graph deriver is not implemented.');
  error.code = 'NOT_IMPLEMENTED';
  throw error;
}