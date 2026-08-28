import {
  OVERCENTER_PROJECT_GRAPH_DERIVATION,
  deriveOvercenterProjectGraph,
} from './overcenter-project-graph-deriver.js';

export const PROJECT_GRAPH_DERIVERS = Object.freeze({
  [OVERCENTER_PROJECT_GRAPH_DERIVATION]:deriveOvercenterProjectGraph,
});
