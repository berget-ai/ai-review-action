import * as github from '@actions/github';
import * as core from '@actions/core';

/**
 * Follow-up review support.
 *
 * Every review the action posts carries a hidden marker with the head SHA it
 * reviewed:  <!-- ai-review-sha: <sha> -->
 *
 * On subsequent runs (new pushes to the PR, or a bare `@berget review` comment)
 * we look up the most recent marker so the review can be *incremental* —
 * diff only what changed since, verify previous findings, and stay terse
 * instead of re-posting the full summary.
 */

const MARKER_RE = /ai-review-sha:\s*([0-9a-f]{7,40})/i;

export const REVIEW_SHA_MARKER_PREFIX = '<!-- ai-review-sha: ';

export function reviewShaMarker(sha: string): string {
  return `${REVIEW_SHA_MARKER_PREFIX}${sha} -->`;
}

export function extractReviewSha(body: string): string | null {
  const m = body.match(MARKER_RE);
  return m ? (m[1] ?? null) : null;
}

export type PreviousReview = {
  /** Head SHA the previous review covered. */
  sha: string;
  /** Previous review/comment body (may be truncated by caller). */
  body: string;
};

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Find the most recent review or PR comment posted by this action (identified
 * by the hidden SHA marker, author-agnostic so it works both with
 * GITHUB_TOKEN and GitHub App credentials).
 */
export async function findPreviousReview({
  octokit,
  prNumber,
}: {
  octokit: Octokit;
  prNumber: number;
}): Promise<PreviousReview | null> {
  const ctx = github.context;

  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      ...ctx.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...ctx.repo,
      issue_number: prNumber,
      per_page: 100,
    });

    type Candidate = { at: number; sha: string; body: string };
    const candidates: Candidate[] = [];

    for (const r of reviews) {
      const sha = extractReviewSha(r.body ?? '');
      if (sha) candidates.push({ at: Date.parse(r.submitted_at ?? '') || 0, sha, body: r.body ?? '' });
    }
    for (const c of comments) {
      const sha = extractReviewSha(c.body ?? '');
      if (sha) candidates.push({ at: Date.parse(c.created_at ?? '') || 0, sha, body: c.body ?? '' });
    }

    const latest = candidates.sort((a, b) => b.at - a.at).at(0);
    if (!latest) return null;

    core.info(`Found previous AI review at ${latest.sha.slice(0, 7)} — running follow-up review`);
    return { sha: latest.sha, body: latest.body };
  } catch (err) {
    core.warning(`Could not look up previous review: ${(err as Error).message} — falling back to full review`);
    return null;
  }
}
