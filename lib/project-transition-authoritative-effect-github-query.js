export function projectTransitionPullRequestReadQuery({ base }) {
  return Object.freeze({ state:'all', base, per_page:100 });
}

export function projectTransitionPullRequestDetailNumbers({ pulls, head }) {
  if (!Array.isArray(pulls) || typeof head !== 'string' || !head) return [];
  return pulls
    .filter((pull) => String(pull?.head?.ref || '') === head
      && Number.isInteger(Number(pull?.number))
      && Number(pull.number) > 0)
    .map((pull) => Number(pull.number));
}
