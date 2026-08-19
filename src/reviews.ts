/**
 * Reduces a pull request's reviews to one verdict, so a list can carry what
 * the humans said without the caller fetching and reading every review.
 *
 * This answers "what did reviewers say", not "may this merge". Branch
 * protection, required approvals and check state are `pr mergeability`'s
 * question, and keeping the two apart is why this ignores the `official` flag:
 * that flag says whether a review counts toward a protection rule, and on a
 * repository with no rule it can be false for every reviewer, which would
 * report a reviewed pull request as unreviewed.
 */

export type ReviewDecision =
  | 'changes_requested'
  | 'approved'
  | 'stale'
  | 'review_requested'
  | 'commented'
  | 'none';

/** The fields of a review this verdict is computed from, and nothing else. */
export interface ReviewSummary {
  state: string | null;
  dismissed: boolean;
  stale: boolean;
}

function isVerdict(state: string | null): 'approve' | 'reject' | null {
  if (state === 'APPROVED') return 'approve';
  if (state === 'REQUEST_CHANGES') return 'reject';
  return null;
}

/**
 * Precedence: a request for changes outranks an approval, and both outrank a
 * pending request or a bare comment.
 *
 * A verdict left on an older commit is reported as `stale` rather than as the
 * verdict itself. Reporting a superseded approval as `approved` is the same
 * error as reporting a superseded check run as passing: it is the reading a
 * caller is most likely to act on and least likely to re-check.
 */
export function evaluateReviewDecision(
  reviews: readonly ReviewSummary[],
): ReviewDecision {
  const live = reviews.filter((review) => !review.dismissed);
  const fresh = live.filter((review) => !review.stale);

  if (fresh.some((review) => isVerdict(review.state) === 'reject'))
    return 'changes_requested';
  if (fresh.some((review) => isVerdict(review.state) === 'approve'))
    return 'approved';
  // Every verdict that survives dismissal is attached to a superseded commit.
  if (live.some((review) => isVerdict(review.state) !== null)) return 'stale';
  if (live.some((review) => review.state === 'REQUEST_REVIEW'))
    return 'review_requested';
  if (live.some((review) => review.state === 'COMMENT')) return 'commented';
  return 'none';
}
