function object(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function projectGraphRevisionResumeEvidence(settleReceipt) {
  const receipt = object(settleReceipt);
  const graphRevisionChange = object(receipt?.graph_revision_change);
  if (graphRevisionChange?.schema !== 'project-graph-revision-change-v1') return null;
  return Object.freeze({ kind:'project_graph_revision_change', graph_revision_change:graphRevisionChange });
}

export function appendProjectGraphRevisionResumeEvidence(packet, graphRevisionEvidence) {
  if (!graphRevisionEvidence) return packet;
  const evidence = Array.isArray(packet?.evidence) ? packet.evidence : [];
  if (evidence.some((entry) => entry?.kind === 'project_graph_revision_change')) return packet;
  return { ...packet, evidence:[...evidence, graphRevisionEvidence] };
}