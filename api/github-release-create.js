import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubReleaseWithGitHubApp } from 'lib/github-release-runtime.js';

export const access='admin';
export const methods=['POST'];
export default async function(req,res){
  const runId=typeof req.body?.run_id==='string'?req.body.run_id:null;
  const response=await executeCorrelatedCommand('github.release.create',req.body||{},request=>createGithubReleaseWithGitHubApp(request,{db,run_id:runId}),{defaultError:'GITHUB_RELEASE_ERROR',defaultMessage:'github.release.create failed',flattenDetails:true,db});
  return res.status(response.status).json(response.body);
}