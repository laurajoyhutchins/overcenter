import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubReleaseWithGitHubApp } from 'lib/github-release.js';

export const access = 'admin';
const expectedState = { type:'object', required:['tag','release'], properties:{ tag:{type:'string',enum:['absent','present_same_commit']}, release:{type:'string',enum:['absent','present_matching']} }, additionalProperties:false };
export default {
  name:'github.release.create',
  description:'Create an immutable lightweight Git tag at an exact observed Git commit and a GitHub Release for that tag. Fail closed on expected-state drift or conflicting existing state. Exact replay converges through durable idempotency evidence; no tag retargeting, release editing, deletion, asset upload, note generation, or commit inference is performed.',
  inputSchema:{type:'object',required:['repo','target_sha','tag_name','name','body','draft','prerelease','expected_state','idempotency_key','run_id'],properties:{repo:{type:'string',pattern:'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},target_sha:{type:'string',pattern:'^[0-9a-fA-F]{40}$'},tag_name:{type:'string',minLength:1,maxLength:255},name:{type:'string',minLength:1,maxLength:256},body:{type:'string',maxLength:125000},draft:{type:'boolean'},prerelease:{type:'boolean'},expected_state:expectedState,idempotency_key:{type:'string',minLength:1,maxLength:200},run_id:{type:'string',minLength:1,maxLength:512}},additionalProperties:false},
  async handler(args,ctx){const response=await executeCorrelatedCommand('github.release.create',args||{},request=>createGithubReleaseWithGitHubApp(request,{db:ctx?.db}),{defaultError:'GITHUB_RELEASE_ERROR',defaultMessage:'github.release.create failed',flattenDetails:true,db:ctx?.db});return response.body;}
};