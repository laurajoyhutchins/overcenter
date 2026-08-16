import { runGitHubAppAuthRegressionTests } from 'lib/github-app-auth.js';
import { runGithubReviewPacketTests } from 'lib/github-review-packet.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const [review_packet, auth_regression] = await Promise.all([
    runGithubReviewPacketTests(),
    runGitHubAppAuthRegressionTests(),
  ]);
  const result = {
    ok: Boolean(review_packet.ok && auth_regression.ok),
    review_packet,
    auth_regression,
  };
  return res.status(result.ok ? 200 : 500).json(result);
}