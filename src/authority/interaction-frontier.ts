import type { State } from './facts.ts';
import { buildGraphIndex, graphDependsOn } from '../graph/topology.ts';
import { effectSemantics, effectsConflict } from '../semantics.ts';

export interface InteractionFrontier {
  components: readonly (readonly string[])[];
  causalEdges: number;
  conflictEdges: number;
}

export function interactionFrontier(state: State): InteractionFrontier {
  const ids = Object.keys(state.obligations).sort();
  const graph = buildGraphIndex(state);
  const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  let causalEdges = 0;
  let conflictEdges = 0;

  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const leftId = ids[leftIndex]!;
      const rightId = ids[rightIndex]!;
      const causal =
        graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId);
      const left = effectSemantics(state.obligations[leftId]!.postcondition);
      const right = effectSemantics(state.obligations[rightId]!.postcondition);
      const conflict = left !== null && right !== null && effectsConflict(left, right);
      if (causal) causalEdges += 1;
      if (conflict) conflictEdges += 1;
      if (!causal && !conflict) continue;
      adjacency.get(leftId)!.add(rightId);
      adjacency.get(rightId)!.add(leftId);
    }
  }

  const unseen = new Set(ids);
  const components: string[][] = [];
  while (unseen.size > 0) {
    const start = [...unseen].sort()[0]!;
    unseen.delete(start);
    const pending = [start];
    const component: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort().reverse()) {
        if (unseen.delete(next)) pending.push(next);
      }
    }
    components.push(component.sort());
  }

  components.sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!));
  return { components, causalEdges, conflictEdges };
}
