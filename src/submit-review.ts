export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface ReviewRequest {
  body: string;
  event: ReviewEvent;
  comments?: ReviewComment[];
}

export interface ReviewApi {
  createReview(request: ReviewRequest): Promise<unknown>;
  createComment(body: string): Promise<unknown>;
  warn(message: string): void;
}

export type ReviewOutcome = 'review' | 'review-without-comments' | 'comment-review' | 'issue-comment';

/**
 * Post the review, degrading without losing the verdict or a finding.
 *
 * A rejected inline comment (GitHub's "Line could not be resolved") falls back
 * to one review carrying the same event, with every finding in the body. A
 * refused verdict ("Can not approve your own pull request") falls back to a
 * COMMENT review. An issue comment is the last resort only: it drops the
 * verdict, and in repos still on the old README concurrency group its
 * issue_comment event cancels this run.
 */
export async function submitReview(
  api: ReviewApi,
  {
    body,
    event,
    comments,
    fallbackBody,
  }: { body: string; event: ReviewEvent; comments: ReviewComment[]; fallbackBody: string },
): Promise<ReviewOutcome> {
  try {
    await api.createReview({ body, event, ...(comments.length > 0 ? { comments } : {}) });
    return 'review';
  } catch (err) {
    api.warn(`createReview failed: ${(err as Error).message}. Retrying with every finding in the review body.`);
  }
  try {
    await api.createReview({ body: fallbackBody, event });
    return 'review-without-comments';
  } catch (err) {
    api.warn(`createReview failed again: ${(err as Error).message}.`);
  }
  if (event !== 'COMMENT') {
    try {
      await api.createReview({ body: fallbackBody, event: 'COMMENT' });
      return 'comment-review';
    } catch (err) {
      api.warn(`COMMENT review failed: ${(err as Error).message}.`);
    }
  }
  api.warn('Posting the review as an issue comment.');
  await api.createComment(fallbackBody);
  return 'issue-comment';
}
