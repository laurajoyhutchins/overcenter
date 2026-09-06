const SHA40=/^[0-9a-f]{40}$/;

export function githubMechanicalCoalescingRecovery(input={}){
  const parentHead=String(input.parent_head||'').trim().toLowerCase();
  if(!SHA40.test(parentHead)) throw new TypeError('parent_head must be an exact 40-character Git SHA');
  return Object.freeze({
    command:'github.coalesce_mechanical_changeset',
    required_fields:Object.freeze(['lease_ref','changes','commit_message']),
    parent_head:parentHead,
  });
}