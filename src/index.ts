import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseReviewTrigger, parseMentionTrigger, containsPiMention } from './parse.js';
import { runReview } from './review.js';
import { runInlineComment } from './inline-comment.js';
import { runIssue } from './issue.js';
import { runDiscussion } from './discussion.js';
import {
  wrapReviewComment,
  wrapInlineComment,
  wrapIssueComment,
  wrapDiscussionComment,
} from './template.js';
import { extractFindings, formatFindingComment } from './inline-findings.js';
import { runAgent, loadDoraSkill, loadObiSkill, ProviderError } from './agent.js';
import { getInstallationToken } from './app-token.js';
import { findPreviousReview, reviewShaMarker } from './previous-review.js';
import type { ReviewConfig, InlineCommentConfig, IssueConfig, DiscussionConfig } from './types.js';

type Octokit = ReturnType<typeof github.getOctokit>;

async function getBaseInputs() {
  // When GitHub App credentials are provided, mint an installation token and
  // use it for all API calls. Unlike GITHUB_TOKEN (github-actions[bot]), an
  // app token is allowed to APPROVE / REQUEST_CHANGES on PR reviews.
  const appId = core.getInput('github_app_id') || '';
  const appPrivateKey = core.getInput('github_app_private_key') || '';
  let token = process.env.GITHUB_TOKEN;
  if (appId && appPrivateKey) {
    const { owner, repo } = github.context.repo;
    token = await getInstallationToken({
      appId,
      privateKey: appPrivateKey,
      installationId: core.getInput('github_app_installation_id') || undefined,
      owner,
      repo,
    });
    core.info('Using GitHub App installation token for API calls');
  }
  if (!token) throw new Error('GITHUB_TOKEN is required');

  const model = core.getInput('model') || core.getInput('pi_model') || 'berget/zai-org/GLM-5.3-Flash';
  const apiKey = core.getInput('api_key') || '';
  const actionPath = core.getInput('action_path') || '';
  const workingDir = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const obsidianVaultName = process.env.INPUT_OBSIDIAN_VAULT_NAME || '';
  const obsidianPrompt = process.env.INPUT_OBSIDIAN_PROMPT || '';
  const autoDiscoverSkills = (process.env.INPUT_AUTO_DISCOVER_SKILLS || 'false').toLowerCase() === 'true';
  const providerBaseUrl = core.getInput('provider_base_url') || 'https://api.berget.ai/v1';

  if (!apiKey && !core.getInput('pi_auth')) {
    throw new Error('Either api_key or pi_auth must be provided');
  }

  return { token, model, apiKey, actionPath, workingDir, obsidianVaultName, obsidianPrompt, autoDiscoverSkills, providerBaseUrl };
}

function isOwnerOrMember({ association }: { association: string }): boolean {
  return association === 'OWNER' || association === 'MEMBER' || association === 'COLLABORATOR';
}

// ---------------------------------------------------------------------------
// pull_request event -> automatic review
// ---------------------------------------------------------------------------

/**
 * Post the review body as either:
 *   - a pull request review with inline line comments (when findings exist)
 *   - a plain issue comment (when no inline findings)
 *
 * When the `approve` input is true, the review event is set based on finding
 * severity: APPROVE if no blockers, REQUEST_CHANGES if at least one blocker.
 * When false (default), the review is always COMMENT.
 */
async function postReview({
  octokit,
  prNumber,
  body,
  model,
  headSha,
}: {
  octokit: Octokit;
  prNumber: number;
  body: string;
  model: string;
  headSha?: string;
}): Promise<void> {
  const ctx = github.context;
  const { findings, bodyWithoutFindings } = extractFindings(body);
  const approve = core.getInput('approve') === 'true';

  // Skip only when the agent produced nothing usable at all. If the agent
  // emitted inline findings without a prose summary, still post the findings
  // with a fallback summary so they are not dropped.
  if (!bodyWithoutFindings.trim() && findings.length === 0) {
    core.warning('Skipping review: agent produced no review body and no findings. No comment posted.');
    return;
  }

  const summaryBody = bodyWithoutFindings.trim() || '_AI review produced inline findings only._';
  // Hidden marker lets the next run detect the last reviewed head SHA and do
  // an incremental follow-up review instead of repeating the full summary.
  const summary =
    wrapReviewComment({ body: summaryBody, model, prNumber }) +
    (headSha ? `\n${reviewShaMarker(headSha)}` : '');

  if (!headSha) {
    // No head SHA — cannot post a review, fall back to issue comment.
    await octokit.rest.issues.createComment({
      ...ctx.repo,
      issue_number: prNumber,
      body: summary,
    });
    core.info('Review posted as issue comment (no head SHA)');
    return;
  }

  if (findings.length === 0 && !approve) {
    // No inline findings and approvals disabled — a plain issue comment is
    // enough (a COMMENT review without line comments adds nothing).
    await octokit.rest.issues.createComment({
      ...ctx.repo,
      issue_number: prNumber,
      body: summary,
    });
    core.info('Review posted as issue comment (no inline findings)');
    return;
  }

  const comments = findings.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT' as const,
    body: formatFindingComment(f),
  }));

  // Determine review event:
  // - approve=false (default): always COMMENT
  // - approve=true: REQUEST_CHANGES if any blocker, else APPROVE
  let event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT';
  if (approve) {
    const hasBlocker = findings.some((f) => f.severity === 'blocker');
    event = hasBlocker ? 'REQUEST_CHANGES' : 'APPROVE';
  }

  core.info(`Review event: ${event} (approve=${approve})`);

  // Try posting all findings as a single review first. If GitHub rejects
  // (e.g. a line number is outside the diff context), fall back to posting
  // each comment individually and skip the ones that fail.
  try {
    await octokit.rest.pulls.createReview({
      ...ctx.repo,
      pull_number: prNumber,
      commit_id: headSha,
      body: summary,
      event,
      // Omit entirely when empty — approve-on-clean-PR posts a review
      // without line comments.
      ...(comments.length > 0 ? { comments } : {}),
    });
    core.info(`Review posted with ${comments.length} inline comments (event=${event})`);
  } catch (err) {
    core.warning(`createReview failed: ${(err as Error).message}. Trying individual comments...`);
    let posted = 0;
    for (const c of comments) {
      try {
        await octokit.rest.pulls.createReview({
          ...ctx.repo,
          pull_number: prNumber,
          commit_id: headSha,
          event: 'COMMENT',
          comments: [c],
        });
        posted++;
      } catch {
        core.warning(`Skipped comment on ${c.path}:${c.line} — line not in diff`);
      }
    }
    // Post the summary as an issue comment so the review body is not lost.
    await octokit.rest.issues.createComment({
      ...ctx.repo,
      issue_number: prNumber,
      body: summary,
    });
    core.info(`Review posted: ${posted}/${comments.length} inline comments + summary as issue comment`);
  }
}

async function handlePullRequest({ octokit }: { octokit: Octokit }): Promise<void> {
  const payload = github.context.payload;
  const pr = payload.pull_request;

  if (!pr) {
    core.info('Skipping: no pull_request in payload');
    return;
  }

  // Skip drafts unless explicitly reviewed
  if (pr.draft) {
    core.info('Skipping: PR is a draft');
    return;
  }

  const { token, model, apiKey, actionPath, workingDir, obsidianVaultName, obsidianPrompt, autoDiscoverSkills, providerBaseUrl } = await getBaseInputs();
  const octokit2 = github.getOctokit(token);
  const ctx = github.context;

  core.info(`Trigger: automatic review | PR #${pr.number} | ${pr.head.ref} → ${pr.base.ref}`);

  // Follow-up review: diff only what changed since our last review.
  const previousReview = await findPreviousReview({ octokit: octokit2, prNumber: pr.number });

  if (previousReview && previousReview.sha === pr.head.sha) {
    core.info('No new commits since previous review — posting a no-op note instead of a full re-review');
    await octokit2.rest.issues.createComment({
      ...ctx.repo,
      issue_number: pr.number,
      body: `No new commits since the previous AI review at \`${pr.head.sha.slice(0, 7)}\` — nothing new to review. Comment \`@berget <what to look at>\` to force a full re-review.\n${reviewShaMarker(pr.head.sha)}`,
    });
    return;
  }

  const reviewConfig: ReviewConfig = {
    prNumber: pr.number,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    repoOwner: ctx.repo.owner,
    repoName: ctx.repo.repo,
    model,
    apiKey,
    extraPrompt: core.getInput('extra_prompt') || '',
    message: '',
    previousReview,
    workingDir,
    useDora: core.getInput('use_dora') !== 'false',
    systemPromptPath: core.getInput('system_prompt') || '',
    reviewTemplatePath: core.getInput('review_template') || '',
    actionPath,
    obsidianVaultName,
    obsidianPrompt,
    autoDiscoverSkills,
    providerBaseUrl,
  };

  const body = await runReview({ config: reviewConfig });

  await postReview({
    octokit: octokit2,
    prNumber: reviewConfig.prNumber,
    body,
    model,
    headSha: pr.head.sha,
  });

  core.info('Review posted');
}

// ---------------------------------------------------------------------------
// issue_comment on a PR -> review or inline (PR-level comment only)
// ---------------------------------------------------------------------------

async function handlePrComment({ octokit }: { octokit: Octokit }): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment?.body) {
    core.info('Skipping: no comment body');
    return;
  }

  if (!isOwnerOrMember({ association: comment.author_association ?? '' })) {
    core.info(`Skipping: author_association is ${comment.author_association}`);
    return;
  }

  const { token, model, apiKey, actionPath, workingDir, obsidianVaultName, obsidianPrompt, autoDiscoverSkills, providerBaseUrl } = await getBaseInputs();
  const octokit2 = github.getOctokit(token);
  const ctx = github.context;

  // Try review trigger first
  const reviewTrigger = parseReviewTrigger({ body: comment.body });
  if (reviewTrigger) {
    core.info(`Trigger: review | message: ${reviewTrigger.message || '(none)'}`);

    await octokit2.rest.reactions.createForIssueComment({
      ...ctx.repo,
      comment_id: comment.id,
      content: 'eyes',
    });

    const issueNumber: number = payload.issue?.number ?? 0;

    const { data: pr } = await octokit2.rest.pulls.get({
      ...ctx.repo,
      pull_number: issueNumber,
    });

    // Bare "@berget" → follow-up review when we have a previous review on
    // record. An explicit message ("@berget focus on X") forces a full
    // review with that focus instead.
    let previousReview = null;
    if (!reviewTrigger.message.trim()) {
      previousReview = await findPreviousReview({ octokit: octokit2, prNumber: issueNumber });

      if (previousReview && previousReview.sha === pr.head.sha) {
        core.info('No new commits since previous review — skipping duplicate');
        await octokit2.rest.issues.createComment({
          ...ctx.repo,
          issue_number: issueNumber,
          body: `No new commits since the previous AI review at \`${pr.head.sha.slice(0, 7)}\` — nothing new to review. Comment \`@berget <what to look at>\` to force a full re-review.\n${reviewShaMarker(pr.head.sha)}`,
        });
        return;
      }
    }

    const reviewConfig: ReviewConfig = {
      prNumber: issueNumber,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      repoOwner: ctx.repo.owner,
      repoName: ctx.repo.repo,
      model,
      apiKey,
      extraPrompt: core.getInput('extra_prompt') || '',
      message: reviewTrigger.message,
      previousReview,
      workingDir,
      useDora: core.getInput('use_dora') !== 'false',
      systemPromptPath: core.getInput('system_prompt') || '',
      reviewTemplatePath: core.getInput('review_template') || '',
      actionPath,
      obsidianVaultName,
      obsidianPrompt,
      autoDiscoverSkills,
      providerBaseUrl,
    };

    const body = await runReview({ config: reviewConfig });

    await postReview({
      octokit: octokit2,
      prNumber: reviewConfig.prNumber,
      body,
      model,
      headSha: pr.head.sha,
    });

    core.info('Review posted');
    return;
  }

  core.info('Skipping: PR comment is not a review trigger');
}

// ---------------------------------------------------------------------------
// pull_request_review_comment -> inline comment on a file
// ---------------------------------------------------------------------------

async function handleInlineComment({ octokit }: { octokit: Octokit }): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment?.body) {
    core.info('Skipping: no comment body');
    return;
  }

  if (!containsPiMention({ body: comment.body })) {
    core.info('Skipping: no @berget mention');
    return;
  }

  if (!isOwnerOrMember({ association: comment.author_association ?? '' })) {
    core.info(`Skipping: author_association is ${comment.author_association}`);
    return;
  }

  const trigger = parseMentionTrigger({ body: comment.body, command: 'comment' });
  if (!trigger) {
    core.info('Skipping: could not parse mention trigger');
    return;
  }

  const { token, model, apiKey, actionPath, workingDir, obsidianVaultName, obsidianPrompt, autoDiscoverSkills, providerBaseUrl } = await getBaseInputs();
  const octokit2 = github.getOctokit(token);
  const ctx = github.context;

  await octokit2.rest.reactions.createForPullRequestReviewComment({
    ...ctx.repo,
    comment_id: comment.id,
    content: 'eyes',
  });

  const prNumber: number = payload.pull_request?.number ?? payload.issue?.number ?? 0;

  const { data: pr } = await octokit2.rest.pulls.get({
    ...ctx.repo,
    pull_number: prNumber,
  });

  const inlineConfig: InlineCommentConfig = {
    prNumber,
    baseBranch: pr.base.ref,
    commentId: comment.id,
    commentBody: comment.body,
    filePath: comment.path ?? '',
    diffHunk: comment.diff_hunk ?? '',
    line: comment.line ?? comment.original_line ?? null,
    message: trigger.message,
    repoOwner: ctx.repo.owner,
    repoName: ctx.repo.repo,
    model,
    apiKey,
    workingDir,
    actionPath,
    obsidianVaultName,
    obsidianPrompt,
    autoDiscoverSkills,
    providerBaseUrl,
  };

  core.info(`Trigger: comment | file: ${inlineConfig.filePath} | message: ${trigger.message || '(none)'}`);

  const body = await runInlineComment({ config: inlineConfig });
  const wrapped = wrapInlineComment({
    body,
    model,
    prNumber,
    filePath: inlineConfig.filePath,
  });

  await octokit2.rest.pulls.createReplyForReviewComment({
    ...ctx.repo,
    pull_number: prNumber,
    comment_id: comment.id,
    body: wrapped,
  });

  core.info('Inline comment reply posted');
}

// ---------------------------------------------------------------------------
// issues (opened / edited) or issue_comment (on a plain issue)
// ---------------------------------------------------------------------------

async function handleIssue({ octokit }: { octokit: Octokit }): Promise<void> {
  const payload = github.context.payload;
  const ctx = github.context;

  // Determine the trigger body and whether we're on an issue comment or the issue itself
  const isIssueComment = ctx.eventName === 'issue_comment';
  const triggerBody: string = isIssueComment
    ? (payload.comment?.body ?? '')
    : (payload.issue?.body ?? '');

  if (!containsPiMention({ body: triggerBody })) {
    core.info('Skipping: no @berget mention');
    return;
  }

  const association: string = isIssueComment
    ? (payload.comment?.author_association ?? '')
    : (payload.issue?.author_association ?? '');

  if (!isOwnerOrMember({ association })) {
    core.info(`Skipping: author_association is ${association}`);
    return;
  }

  const trigger = parseMentionTrigger({ body: triggerBody, command: 'issue' });
  if (!trigger) {
    core.info('Skipping: could not parse mention trigger');
    return;
  }

  const { token, model, apiKey, actionPath, workingDir, obsidianVaultName, obsidianPrompt, autoDiscoverSkills, providerBaseUrl } = await getBaseInputs();
  const octokit2 = github.getOctokit(token);

  // React on the comment or the issue itself
  if (isIssueComment && payload.comment?.id) {
    await octokit2.rest.reactions.createForIssueComment({
      ...ctx.repo,
      comment_id: payload.comment.id,
      content: 'eyes',
    });
  }

  const issue = payload.issue;
  const issueConfig: IssueConfig = {
    issueNumber: issue?.number ?? 0,
    issueTitle: issue?.title ?? '',
    issueBody: issue?.body ?? '',
    commentBody: isIssueComment ? (payload.comment?.body ?? null) : null,
    message: trigger.message,
    repoOwner: ctx.repo.owner,
    repoName: ctx.repo.repo,
    model,
    apiKey,
    workingDir,
    actionPath,
    obsidianVaultName,
    obsidianPrompt,
    autoDiscoverSkills,
    providerBaseUrl,
  };

  core.info(`Trigger: issue #${issueConfig.issueNumber} | message: ${trigger.message || '(none)'}`);

  const body = await runIssue({ config: issueConfig });
  const wrapped = wrapIssueComment({ body, model, issueNumber: issueConfig.issueNumber });

  await octokit2.rest.issues.createComment({
    ...ctx.repo,
    issue_number: issueConfig.issueNumber,
    body: wrapped,
  });

  core.info('Issue reply posted');
}

// ---------------------------------------------------------------------------
// discussion or discussion_comment
// ---------------------------------------------------------------------------

async function handleDiscussion({ octokit }: { octokit: Octokit }): Promise<void> {
  const payload = github.context.payload;
  const ctx = github.context;

  const isDiscussionComment = ctx.eventName === 'discussion_comment';
  const triggerBody: string = isDiscussionComment
    ? (payload.comment?.body ?? '')
    : (payload.discussion?.body ?? '');

  if (!containsPiMention({ body: triggerBody })) {
    core.info('Skipping: no @berget mention');
    return;
  }

  // Discussions don't have author_association on the payload in the same way;
  // we trust the workflow-level `if:` condition to gate this.

  const trigger = parseMentionTrigger({ body: triggerBody, command: 'discussion' });
  if (!trigger) {
    core.info('Skipping: could not parse mention trigger');
    return;
  }

  const { token, model, apiKey, actionPath, workingDir, obsidianVaultName, obsidianPrompt, autoDiscoverSkills, providerBaseUrl } = await getBaseInputs();
  const octokit2 = github.getOctokit(token);

  const discussion = payload.discussion;
  const discussionConfig: DiscussionConfig = {
    discussionNumber: discussion.number,
    discussionTitle: discussion.title ?? '',
    discussionBody: discussion.body ?? '',
    commentBody: isDiscussionComment ? (payload.comment?.body ?? null) : null,
    discussionNodeId: discussion.node_id ?? '',
    commentNodeId: isDiscussionComment ? (payload.comment?.node_id ?? null) : null,
    message: trigger.message,
    repoOwner: ctx.repo.owner,
    repoName: ctx.repo.repo,
    model,
    apiKey,
    workingDir,
    actionPath,
    obsidianVaultName,
    obsidianPrompt,
    autoDiscoverSkills,
    providerBaseUrl,
  };

  core.info(`Trigger: discussion #${discussionConfig.discussionNumber} | message: ${trigger.message || '(none)'}`);

  const body = await runDiscussion({ config: discussionConfig });
  const wrapped = wrapDiscussionComment({
    body,
    model,
    discussionNumber: discussionConfig.discussionNumber,
  });

  // GitHub Discussions require the GraphQL API to post comments
  await postDiscussionComment({
    octokit: octokit2,
    discussionNodeId: discussionConfig.discussionNodeId,
    replyToNodeId: discussionConfig.commentNodeId,
    body: wrapped,
  });

  core.info('Discussion reply posted');
}

async function postDiscussionComment({
  octokit,
  discussionNodeId,
  replyToNodeId,
  body,
}: {
  octokit: Octokit;
  discussionNodeId: string;
  replyToNodeId: string | null;
  body: string;
}): Promise<void> {
  if (replyToNodeId) {
    // Reply to a specific comment in the discussion
    await octokit.graphql(
      `mutation AddDiscussionComment($discussionId: ID!, $replyToId: ID!, $body: String!) {
        addDiscussionComment(input: {
          discussionId: $discussionId,
          replyToId: $replyToId,
          body: $body
        }) {
          comment { id }
        }
      }`,
      { discussionId: discussionNodeId, replyToId: replyToNodeId, body },
    );
  } else {
    // Top-level comment on the discussion
    await octokit.graphql(
      `mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: {
          discussionId: $discussionId,
          body: $body
        }) {
          comment { id }
        }
      }`,
      { discussionId: discussionNodeId, body },
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is required');

    const octokit = github.getOctokit(token);
    const { eventName, payload } = github.context;

    core.info(`Event: ${eventName}`);

    // Fork PRs do not receive repository secrets, so external contributors'
    // PRs would otherwise fail the workflow with a red X. Skip gracefully
    // instead — no credentials means nothing to bill the review to anyway.
    const isForkPr = payload.pull_request?.head?.repo?.fork === true;
    if (isForkPr && !core.getInput('api_key') && !core.getInput('pi_auth')) {
      core.notice(
        'Skipping: no api_key/pi_auth available in this context. ' +
          'Fork pull requests do not receive repository secrets, so AI review is not possible. ' +
          'A maintainer can re-trigger with `@berget` from the base repo if desired.',
      );
      return;
    }

    // pull_request event -> automatic review
    if (eventName === 'pull_request' && payload.pull_request) {
      await handlePullRequest({ octokit });
      return;
    }

    // PR-level comment -> review
    if (eventName === 'issue_comment' && payload.issue?.pull_request) {
      await handlePrComment({ octokit });
      return;
    }

    // Inline PR file comment
    if (eventName === 'pull_request_review_comment') {
      await handleInlineComment({ octokit });
      return;
    }

    // Issue opened/edited body contains @berget, OR a comment on a plain issue
    if (
      (eventName === 'issues' && !payload.issue?.pull_request) ||
      (eventName === 'issue_comment' && !payload.issue?.pull_request)
    ) {
      await handleIssue({ octokit });
      return;
    }

    // Discussion created/edited or a discussion comment
    if (eventName === 'discussion' || eventName === 'discussion_comment') {
      await handleDiscussion({ octokit });
      return;
    }

    core.info(`Skipping: unhandled event ${eventName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof ProviderError) {
      core.setFailed(message);
      await postErrorComment(error).catch((e) =>
        core.warning(`Could not post error comment: ${(e as Error).message}`),
      );
    } else {
      core.setFailed(message);
    }
  }
}

async function postErrorComment(error: ProviderError): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  const octokit = github.getOctokit(token);
  const ctx = github.context;
  const payload = github.context.payload;
  const model = core.getInput('model') || core.getInput('pi_model') || 'berget/zai-org/GLM-5.3-Flash';

  const body = [
    '## AI Review could not run',
    '',
    '```',
    error.message,
    '```',
    '',
    error.isBilling
      ? '> [!WARNING]\n> The model provider returned a billing or rate-limit error. Top up your balance to resume AI reviews.'
      : '> [!CAUTION]\n> The model provider returned an authentication or availability error. Check the API key and provider status.',
    '',
    `<sub>Berget AI (${model})</sub>`,
  ].join('\n');

  // PR review or PR comment
  const prNumber = payload.pull_request?.number ?? payload.issue?.number;
  if (prNumber && !payload.discussion) {
    await octokit.rest.issues.createComment({
      ...ctx.repo,
      issue_number: prNumber,
      body,
    });
    core.info(`Posted error comment on #${prNumber}`);
    return;
  }

  // Plain issue
  if (payload.issue && !payload.issue.pull_request) {
    await octokit.rest.issues.createComment({
      ...ctx.repo,
      issue_number: payload.issue.number,
      body,
    });
    core.info(`Posted error comment on issue #${payload.issue.number}`);
    return;
  }

  // Discussion (GraphQL required)
  if (payload.discussion) {
    await octokit.graphql(
      `mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment { id }
        }
      }`,
      { discussionId: payload.discussion.node_id, body },
    );
    core.info('Posted error comment on discussion');
  }
}

run();
