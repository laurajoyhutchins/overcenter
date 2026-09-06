export function projectTransitionPullRequestReadQuery({ base }) {
  return Object.freeze({ state:'all', base, per_page:100 });
}
