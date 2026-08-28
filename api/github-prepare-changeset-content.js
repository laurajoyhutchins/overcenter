import { storage } from 'hatchable';
import { GitHubContentTransportError, githubContentTransportErrorResult, prepareGithubContentReference } from 'lib/github-content-transport.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const body = req.body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'content')) {
    return res.status(422).json({ ok:false, error:'INVALID_REQUEST', message:'Provide only canonical UTF-8 content.' });
  }
  try {
    const prepared = await prepareGithubContentReference(body.content, { storage });
    return res.status(200).json({ ok:true, ...prepared });
  } catch (error) {
    const result = githubContentTransportErrorResult(error);
    return res.status(error instanceof GitHubContentTransportError ? error.httpStatus : 422).json(result);
  }
}