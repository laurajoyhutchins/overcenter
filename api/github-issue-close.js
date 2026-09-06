import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { closeGithubIssue } from 'lib/github-work-surface-close.js';
export const access='admin'; export const methods=['POST'];
export default async function(req,res){const response=await executeCorrelatedCommand('github.issue.close',req.body||{},input=>closeGithubIssue(input),{flattenDetails:true});return res.status(response.status).json(response.body);}