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
  id: number | null;
  reviewer: string | null;
  submitted_at: string | null;
  state: string | null;
  dismissed: boolean;
  stale: boolean;
}

function isVerdict(state: string | null): 'approve' | 'reject' | null {
  if (state === 'APPROVED') return 'approve';
  if (state === 'REQUEST_CHANGES') return 'reject';
  return null;
}

function isLaterReview(
  candidate: ReviewSummary,
  candidateIndex: number,
  current: ReviewSummary,
  currentIndex: number,
): boolean {
  const candidateTime = Date.parse(candidate.submitted_at ?? '');
  const currentTime = Date.parse(current.submitted_at ?? '');
  if (
    Number.isFinite(candidateTime) &&
    Number.isFinite(currentTime) &&
    candidateTime !== currentTime
  ) {
    return candidateTime > currentTime;
  }
  if (
    candidate.id !== null &&
    current.id !== null &&
    candidate.id !== current.id
  ) {
    return candidate.id > current.id;
  }
  return candidateIndex > currentIndex;
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
  const latestByReviewer = new Map<
    string,
    { review: ReviewSummary; index: number }
  >();
  const anonymousVerdicts: ReviewSummary[] = [];
  live.forEach((review, index) => {
    if (isVerdict(review.state) === null) return;
    const reviewer = review.reviewer?.toLowerCase();
    if (!reviewer) {
      anonymousVerdicts.push(review);
      return;
    }
    const current = latestByReviewer.get(reviewer);
    if (
      !current ||
      isLaterReview(review, index, current.review, current.index)
    ) {
      latestByReviewer.set(reviewer, { review, index });
    }
  });
  const verdicts = [
    ...Array.from(latestByReviewer.values(), ({ review }) => review),
    ...anonymousVerdicts,
  ];
  const fresh = verdicts.filter((review) => !review.stale);

  if (fresh.some((review) => isVerdict(review.state) === 'reject'))
    return 'changes_requested';
  if (fresh.some((review) => isVerdict(review.state) === 'approve'))
    return 'approved';
  // Every reviewer's current verdict is attached to a superseded commit.
  if (verdicts.length > 0) return 'stale';
  if (live.some((review) => review.state === 'REQUEST_REVIEW'))
    return 'review_requested';
  if (live.some((review) => review.state === 'COMMENT')) return 'commented';
  return 'none';
}
