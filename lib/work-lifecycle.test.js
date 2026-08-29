import {
  PRODUCTIVE_STAGES,
  OPERATING_CONDITIONS,
  STAGE_COMMANDS,
  successfulStageResponsibilities,
  resolveCompletedStage,
  resolveWorkLifecycle,
  resolveLifecycleAfterRecovery,
} from './work-lifecycle.js';
import {
  LEGACY_LANE_BY_STAGE,
  STAGE_BY_LEGACY_LANE,
  legacyProjectionForStage,
} from './legacy-lane-compatibility.js';

function assert(value, message) { if (!value) throw new Error(message); }
function factsFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable: true, satisfied: stageIndex < index }]));
}
function doneFacts() { return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable:true, satisfied:true }])); }

export async function runWorkLifecycleTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({name,ok:true}); } catch (error) { tests.push({name,ok:false,error:String(error?.message||error)}); } }

  await test('canonical productive stages and commands are exact', async()=>{
    assert(JSON.stringify(PRODUCTIVE_STAGES) === JSON.stringify(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM']), 'stage order drifted');
    assert(JSON.stringify(Object.values(STAGE_COMMANDS)) === JSON.stringify(['work.enable','work.acquire','work.execute','work.commit','work.confirm']), 'commands drifted');
  });
  await test('all twenty directed productive transitions emerge from one resolver', async()=>{
    let count=0;
    for (const from of PRODUCTIVE_STAGES) for (const to of PRODUCTIVE_STAGES) if (from!==to) {
      const result=resolveWorkLifecycle({current_stage:from,responsibilities:factsFor(to)});
      assert(result.next_stage===to, `${from}->${to} resolved to ${result.next_stage}`);
      count+=1;
    }
    assert(count===20, `expected 20 transitions, got ${count}`);
  });
  await test('forward skip is derived from satisfied responsibilities', async()=>{
    const r=resolveWorkLifecycle({current_stage:'ENABLE',responsibilities:factsFor('COMMIT')});
    assert(r.next_stage==='COMMIT'&&r.transition_kind==='forward_bypass','forward bypass not derived');
  });
  await test('feedback transition is derived from newly unsatisfied responsibility', async()=>{
    const r=resolveWorkLifecycle({current_stage:'CONFIRM',responsibilities:factsFor('ACQUIRE')});
    assert(r.next_stage==='ACQUIRE'&&r.transition_kind==='feedback','feedback not derived');
  });
  await test('all satisfied responsibilities resolve to DONE', async()=>{
    const r=resolveWorkLifecycle({current_stage:'CONFIRM',responsibilities:doneFacts()});
    assert(r.complete===true&&r.next_stage==='DONE'&&r.command===null,'completion not resolved');
  });
  await test('not-applicable responsibilities are skipped', async()=>{
    const facts=doneFacts(); facts.ACQUIRE={applicable:false,satisfied:false}; facts.EXECUTE={applicable:true,satisfied:false};
    const r=resolveWorkLifecycle({current_stage:'ENABLE',responsibilities:facts});
    assert(r.next_stage==='EXECUTE','not-applicable stage was not skipped');
  });
  await test('off-nominal conditions preserve productive responsibility', async()=>{
    for (const condition of OPERATING_CONDITIONS.filter((x)=>x!=='NOMINAL')) {
      const r=resolveWorkLifecycle({current_stage:'EXECUTE',condition,responsibilities:factsFor('COMMIT')});
      assert(r.condition===condition&&r.next_stage==='EXECUTE'&&r.transition_kind==='off_nominal','off-nominal condition changed productive stage');
    }
  });
  await test('recovery performs fresh resolution rather than returning to prior stage', async()=>{
    const r=resolveLifecycleAfterRecovery({current_stage:'EXECUTE',condition:'NOMINAL',responsibilities:factsFor('ACQUIRE')});
    assert(r.next_stage==='ACQUIRE','recovery did not freshly resolve');
  });
  await test('invalid stage condition and responsibility input fail closed', async()=>{
    for (const fn of [
      ()=>resolveWorkLifecycle({current_stage:'MAGIC',responsibilities:doneFacts()}),
      ()=>resolveWorkLifecycle({current_stage:'ENABLE',condition:'MAYBE',responsibilities:doneFacts()}),
      ()=>resolveWorkLifecycle({current_stage:'ENABLE',responsibilities:{...doneFacts(),MAGIC:{applicable:true,satisfied:false}}}),
    ]) { let failed=false; try { fn(); } catch { failed=true; } assert(failed,'invalid input was accepted'); }
  });
  await test('completed stage defaults to the next productive responsibility', async()=>{
    const acquire=resolveCompletedStage({current_stage:'ACQUIRE'});
    const execute=resolveCompletedStage({current_stage:'EXECUTE'});
    const commit=resolveCompletedStage({current_stage:'COMMIT'});
    const confirm=resolveCompletedStage({current_stage:'CONFIRM'});
    assert(acquire.next_stage==='EXECUTE','Acquire did not advance to Execute');
    assert(execute.next_stage==='COMMIT','Execute did not advance to Commit');
    assert(commit.next_stage==='CONFIRM','Commit did not advance to Confirm');
    assert(confirm.next_stage==='DONE','Confirm did not advance to Done');
    assert(successfulStageResponsibilities('EXECUTE').EXECUTE.satisfied===true,'completed stage facts missing');
    assert(successfulStageResponsibilities('EXECUTE').COMMIT.satisfied===false,'later stage was marked satisfied');
  });
  await test('caller reports facts rather than a successor', async()=>{
    const r=resolveCompletedStage({current_stage:'CONFIRM',lifecycle_facts:{responsibilities:factsFor('EXECUTE')}});
    assert(r.next_stage==='EXECUTE'&&r.transition_kind==='feedback','reported facts did not derive remediation stage');
    let failed=false; try { resolveCompletedStage({current_stage:'EXECUTE',lifecycle_facts:{next_stage:'CONFIRM',responsibilities:factsFor('CONFIRM')}}); } catch { failed=true; }
    assert(failed,'caller-selected successor field was accepted');
  });
  await test('legacy lanes are projection-only mappings from canonical stages', async()=>{
    assert(LEGACY_LANE_BY_STAGE.ENABLE==='lane:enable','Enable projection wrong');
    assert(LEGACY_LANE_BY_STAGE.ACQUIRE==='lane:source-implementation','Acquire projection wrong');
    assert(LEGACY_LANE_BY_STAGE.EXECUTE==='lane:repo-implementation','Execute projection wrong');
    assert(LEGACY_LANE_BY_STAGE.COMMIT==='lane:integration','Commit projection wrong');
    assert(LEGACY_LANE_BY_STAGE.CONFIRM==='lane:verification','Confirm projection wrong');
    assert(STAGE_BY_LEGACY_LANE['lane:verification']==='CONFIRM','reverse projection wrong');
    assert(legacyProjectionForStage('DONE','lane:verification').state==='Done','Done projection wrong');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}