import { expect, test } from 'bun:test';
import { submitReview, type ReviewApi, type ReviewRequest } from './submit-review.js';

const comment = { path: 'src/a.ts', line: 3, side: 'RIGHT' as const, body: 'nit' };

function fakeApi(failures: number): ReviewApi & { reviews: ReviewRequest[]; comments: string[]; warnings: string[] } {
  let remaining = failures;
  const reviews: ReviewRequest[] = [];
  const comments: string[] = [];
  const warnings: string[] = [];
  return {
    reviews,
    comments,
    warnings,
    warn(message) {
      warnings.push(message);
    },
    async createReview(request) {
      if (remaining > 0) {
        remaining--;
        throw new Error('Unprocessable Entity: Line could not be resolved');
      }
      reviews.push(request);
    },
    async createComment(body) {
      comments.push(body);
    },
  };
}

test('submitReview: given GitHub accepts the review, posts it once with its comments', async () => {
  const api = fakeApi(0);

  const outcome = await submitReview(api, { body: 'summary', event: 'APPROVE', comments: [comment], fallbackBody: 'all' });

  expect(outcome).toBe('review');
  expect(api.reviews).toEqual([{ body: 'summary', event: 'APPROVE', comments: [comment] }]);
  expect(api.comments).toEqual([]);
});

test('submitReview: given GitHub rejects an inline comment, keeps the event and moves findings into one review body', async () => {
  const api = fakeApi(1);

  const outcome = await submitReview(api, { body: 'summary', event: 'REQUEST_CHANGES', comments: [comment], fallbackBody: 'all' });

  expect(outcome).toBe('review-without-comments');
  expect(api.reviews).toEqual([{ body: 'all', event: 'REQUEST_CHANGES' }]);
  expect(api.comments).toEqual([]);
  expect(api.warnings[0]).toContain('Line could not be resolved');
});

test('submitReview: given GitHub refuses the verdict itself, posts a COMMENT review with every finding', async () => {
  const api = fakeApi(2);

  const outcome = await submitReview(api, { body: 'summary', event: 'APPROVE', comments: [comment], fallbackBody: 'all' });

  expect(outcome).toBe('comment-review');
  expect(api.reviews).toEqual([{ body: 'all', event: 'COMMENT' }]);
  expect(api.comments).toEqual([]);
});

test('submitReview: given a COMMENT review is rejected twice, does not retry the same request', async () => {
  const api = fakeApi(2);

  const outcome = await submitReview(api, { body: 'summary', event: 'COMMENT', comments: [comment], fallbackBody: 'all' });

  expect(outcome).toBe('issue-comment');
  expect(api.comments).toEqual(['all']);
});

test('submitReview: given GitHub rejects every review, posts the full body as an issue comment', async () => {
  const api = fakeApi(3);

  const outcome = await submitReview(api, { body: 'summary', event: 'APPROVE', comments: [comment], fallbackBody: 'all' });

  expect(outcome).toBe('issue-comment');
  expect(api.reviews).toEqual([]);
  expect(api.comments).toEqual(['all']);
});

test('submitReview: given no inline comments, omits the comments field', async () => {
  const api = fakeApi(0);

  await submitReview(api, { body: 'summary', event: 'APPROVE', comments: [], fallbackBody: 'summary' });

  expect(api.reviews).toEqual([{ body: 'summary', event: 'APPROVE' }]);
});
