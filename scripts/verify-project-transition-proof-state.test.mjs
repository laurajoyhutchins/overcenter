import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveProjectTransitionProofState } from '../lib/project-transition-proof-state.js';

const authority={kind:'github',repository:'laurajoyhutchins/overcenter',revision:'affb51bdebc98089847d0de870162fd62d4d8b60',derivation:'overcenter-project-graph-v1'};
const transition={id:'proof',priority:1,requires:[],state:'READY',executor:{kind:'agent'},execution_intent:{desired_outcome:'Make proof visible.',acceptance_evidence:[{kind:'decision',requirement:'show decision boundary'},{kind:'verification',requirement:'prove exact revision'}]}};

test('proof state exposes holes and next reasoning boundary',async()=>{const proof=await deriveProjectTransitionProofState({transition,authority,evidence:[{kind:'verification',ref:'github-actions:1'}]});assert.equal(proof.desired_outcome,'Make proof visible.');assert.equal(proof.next_legal_action.kind,'reasoning_judgment');assert.deepEqual(proof.unresolved_obligations,['decision']);assert.equal(proof.acceptance_obligations.find((x)=>x.kind==='verification').status,'satisfied');assert.match(proof.obligation_fingerprint,/^[0-9a-f]{64}$/);});

test('stale evidence is never current proof',async()=>{const proof=await deriveProjectTransitionProofState({transition,authority,evidence:[{kind:'decision',ref:'old',authority_revision:'0000000000000000000000000000000000000000'}]});assert.equal(proof.stale.value,true);assert.deepEqual(proof.unresolved_obligations,['decision','verification']);});

test('suspension becomes bounded external wait',async()=>{const proof=await deriveProjectTransitionProofState({transition,authority,occupancy:{suspended:true,suspension_reason:'blocked_settlement_promotion',suspension:{recovery_ref:'promotion:1'}}});assert.equal(proof.next_legal_action.kind,'external_wait');assert.equal(proof.next_legal_action.recovery_ref,'promotion:1');});
