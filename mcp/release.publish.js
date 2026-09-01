import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { releasePublishingFor } from 'lib/release-publish-overcenter-host.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('release.publish');

export const access = 'admin';

export default {
  name:'release.publish',
  description:'Publish one exact verified semantic release plan. The caller supplies only the plan and release notes; Overcenter revalidates current Git authority and repository-owned transition impacts, derives provider release bookkeeping, invokes the immutable release primitive, and returns verified publication evidence.',
  inputSchema:descriptor.input_schema,
  async handler(args, ctx) {
    const db = ctx?.db || hatchableDb;
    const response = await executeCorrelatedCommand(
      'release.publish',
      args || {},
      (input) => releasePublishingFor({ db }).publish(input),
      { defaultError:'RELEASE_PUBLISH_ERROR', defaultMessage:'release.publish failed', flattenDetails:true, db },
    );
    return response.body;
  },
};
