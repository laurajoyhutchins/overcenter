import { db as hatchableDb } from 'hatchable';

const INVOCATION_REF=/^invocation:([A-Za-z0-9._:-]{1,128})$/;

function failure(code,message,details={}){
  const error=new Error(message);
  error.code=code;
  error.details=details;
  return error;
}

function parseInvocationRef(value){
  if(typeof value!=='string') throw failure('REQUEST_INVALID','invocation_ref must be an opaque invocation reference',{field:'invocation_ref'});
  const match=INVOCATION_REF.exec(value.trim());
  if(!match) throw failure('REQUEST_INVALID','invocation_ref must use invocation:<id>',{field:'invocation_ref'});
  return {invocation_id:match[1],invocation_ref:`invocation:${match[1]}`};
}

function stateFor(row){
  return String(row?.outcome||'running');
}

function mutationCertainty(row){
  if(row?.may_have_mutated===false) return 'definitively_absent';
  if(row?.may_have_mutated===true || row?.outcome==='indeterminate') return 'unknown';
  return 'not_applicable';
}

function bounded(value,max){
  if(value===undefined || value===null) return null;
  return String(value).slice(0,max);
}

export function createInvocationReconnectService(options={}){
  const store=options.store;
  if(!store || typeof store.invocationById!=='function') throw new TypeError('invocation reconnect store is required');
  async function read(input){
    const parsed=parseInvocationRef(input?.invocation_ref);
    const row=await store.invocationById(parsed.invocation_id);
    if(!row) throw failure('INVOCATION_NOT_FOUND','invocation was not found',{invocation_ref:parsed.invocation_ref});
    return {parsed,row};
  }
  return {
    async attach(input){
      const {parsed,row}=await read(input);
      return {
        ok:true,
        schema:'invocation-attachment-v1',
        invocation_ref:parsed.invocation_ref,
        run_ref:row.run_id ? `run:${String(row.run_id)}` : null,
        state:stateFor(row),
        reconnect_ref:parsed.invocation_ref,
      };
    },
    async peek(input){
      const {parsed,row}=await read(input);
      return {
        ok:true,
        schema:'invocation-peek-v1',
        invocation_ref:parsed.invocation_ref,
        run_ref:row.run_id ? `run:${String(row.run_id)}` : null,
        sequence:row.sequence==null ? null : Number(row.sequence),
        command:bounded(row.command,128),
        target_kind:bounded(row.target_kind,128),
        target_ref:bounded(row.target_ref,512),
        outcome:stateFor(row),
        error_code:bounded(row.error_code,128),
        may_have_mutated:row.may_have_mutated===true,
        mutation_certainty:mutationCertainty(row),
        started_at:row.started_at || null,
        completed_at:row.completed_at || null,
      };
    },
  };
}

export function createPostgresInvocationReconnectStore(dbBinding=hatchableDb){
  return {
    async invocationById(invocationId){
      const result=await dbBinding.query(
        `SELECT invocation_id,run_id,sequence,command,target_kind,target_ref,outcome,error_code,may_have_mutated,started_at,completed_at
           FROM orchestration_command_invocations
          WHERE invocation_id=$1
          LIMIT 1`,
        [invocationId],
      );
      return result.rows?.[0] || null;
    },
  };
}

export function invocationReconnectFor(options={}){
  const dbBinding=options.db || hatchableDb;
  return createInvocationReconnectService({store:options.store || createPostgresInvocationReconnectStore(dbBinding)});
}

export function statusForInvocationReconnectError(error){
  if(error?.code==='REQUEST_INVALID') return 400;
  if(error?.code==='INVOCATION_NOT_FOUND') return 404;
  return null;
}