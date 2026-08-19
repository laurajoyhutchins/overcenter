import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGithubRepository } from 'lib/github-repository-create.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'github.repository.create',
    req.body || {},
    (input) => createGithubRepository(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}