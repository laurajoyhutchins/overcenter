import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectArtifactBinding, classifyBoundArtifactSatisfaction } from './project-artifact-binding.js';
const REVISION='0eab1f9a7c467194d3b5e0e61c46650b1d19b8a3';
test('explicit binding preserves exact semantic and provider identity',()=>{
 const binding=createProjectArtifactBinding({project_ref:'github:laurajoyhutchins/overcenter',transition_id:'add-project-artifact-binding',authority_revision:REVISION,relationship:'full-coverage-equivalence',provider:{repository:'laurajoyhutchins/overcenter',kind:'issue',id:42,state:'open'},satisfaction:{kind:'provider-closed',requires_exact_binding:true}});
 assert.equal(binding.schema,'project-artifact-binding-v1');
 assert.equal(binding.provenance,'explicit-judgment');
 assert.deepEqual(binding.subject,{project_ref:'github:laurajoyhutchins/overcenter',transition_id:'add-project-artifact-binding',authority_revision:REVISION});
 assert.deepEqual(binding.provider,{repository:'laurajoyhutchins/overcenter',kind:'issue',id:42,state:'open'});
 assert.equal(binding.relationship,'full-coverage-equivalence');
 assert.deepEqual(binding.satisfaction,{kind:'provider-closed',requires_exact_binding:true});
});
test('only an exactly bound artifact can mechanically satisfy the obligation',()=>{
 const binding=createProjectArtifactBinding({project_ref:'github:laurajoyhutchins/overcenter',transition_id:'add-project-artifact-binding',authority_revision:REVISION,relationship:'full-coverage-equivalence',provider:{repository:'laurajoyhutchins/overcenter',kind:'issue',id:42,state:'open'},satisfaction:{kind:'provider-closed',requires_exact_binding:true}});
 assert.deepEqual(classifyBoundArtifactSatisfaction(binding,{repository:'laurajoyhutchins/overcenter',kind:'issue',id:42,state:'closed'}),{classification:'satisfied',evidence:{provider_state:'closed',provider_id:42}});
 assert.deepEqual(classifyBoundArtifactSatisfaction(binding,{repository:'laurajoyhutchins/overcenter',kind:'issue',id:43,state:'closed'}),{classification:'ambiguous',evidence:{reason:'artifact-not-explicitly-bound'}});
});
test('binding fails closed on repository or authority ambiguity',()=>{
 assert.throws(()=>createProjectArtifactBinding({project_ref:'github:laurajoyhutchins/overcenter',transition_id:'add-project-artifact-binding',authority_revision:'not-a-revision',relationship:'full-coverage-equivalence',provider:{repository:'laurajoyhutchins/overcenter',kind:'issue',id:42,state:'open'},satisfaction:{kind:'provider-closed',requires_exact_binding:true}}),/authority_revision/);
 assert.throws(()=>createProjectArtifactBinding({project_ref:'github:laurajoyhutchins/overcenter',transition_id:'add-project-artifact-binding',authority_revision:REVISION,relationship:'full-coverage-equivalence',provider:{repository:'someone/else',kind:'issue',id:42,state:'open'},satisfaction:{kind:'provider-closed',requires_exact_binding:true}}),/repository/);
});