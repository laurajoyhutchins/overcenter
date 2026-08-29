import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubReleaseWithGitHubApp } from 'lib/github-release-runtime.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('github.release.create');

export const access='admin';
export default { name:descriptor.mcp_name, description:descriptor.description, inputSchema:descriptor.input_schema, async handler(args,ctx){ const response=await executeCorrelatedCommand('github.release.create',args||{},request=>createGithubReleaseWithGitHubApp(request,{db:ctx?.db}),{defaultError:'GITHUB_RELEASE_ERROR',defaultMessage:'github.release.create failed',flattenDetails:true,db:ctx?.db}); return response.body; } };
