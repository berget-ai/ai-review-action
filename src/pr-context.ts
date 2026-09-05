import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as core from '@actions/core';

export type PrContextOptions = {
  workingDir: string;
  baseBranch: string;
  /**
   * Follow-up review: only diff changes since this SHA (the previously
   * reviewed head). Falls back to the full base...HEAD diff when the SHA is
   * not an ancestor of HEAD (e.g. after a rebase).
   */
  sinceSha?: string;
};

export type PrContext = {
  diff: string;
  changedFiles: string[];
  fileContents: { path: string; content: string }[];
  behindBase: { sha: string; message: string }[];
  conflictingFiles: string[];
  canAutoMerge: boolean;
  /** Effective since-SHA actually used for the incremental diff, if any. */
  incrementalSince?: string;
  /** New commits since the previous review (when incremental). */
  newCommits: { sha: string; message: string }[];
};

const FULL_FILE_LIMIT = 3;
const MAX_FILE_BYTES = 30_000;
const MAX_DIFF_BYTES = 60_000;
const MAX_CONTEXT_BYTES = 80_000;

const DIFF_EXCLUDES = [':!*.lock', ':!*lock.json', ':!*.svg', ':!*.png'];

export function gatherPrContext({ workingDir, baseBranch, sinceSha }: PrContextOptions): PrContext {
  // Follow-up reviews diff only what changed since the previously reviewed
  // head. Guard against the SHA disappearing from history (rebase/force-push)
  // by requiring it to be an ancestor of HEAD — otherwise do a full review.
  let range = `${baseBranch}...HEAD`;
  let incrementalSince: string | undefined;
  if (sinceSha) {
    const { status } = runGitAllowFail(workingDir, ['merge-base', '--is-ancestor', sinceSha, 'HEAD']);
    if (status === 0) {
      range = `${sinceSha}..HEAD`;
      incrementalSince = sinceSha;
    } else {
      core.info(`sinceSha ${sinceSha.slice(0, 7)} is not an ancestor of HEAD (rebased?) — full diff instead`);
    }
  }

  const diff = runGit(workingDir, ['diff', range, '--', ...DIFF_EXCLUDES]);

  const changedFiles = runGit(workingDir, ['diff', range, '--name-only', '--', ...DIFF_EXCLUDES])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  core.info(`PR context: ${changedFiles.length} changed files, ${byteLength(diff)} diff bytes${incrementalSince ? ` (incremental since ${incrementalSince.slice(0, 7)})` : ''}`);

  const newCommits = incrementalSince
    ? runGit(workingDir, ['log', `${incrementalSince}..HEAD`, '--oneline', '--no-decorate'])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split(/\s+/);
          return { sha: sha ?? '', message: rest.join(' ').trim() };
        })
        .filter((c) => c.sha)
    : [];

  const fileContents = selectFilesForContext(workingDir, changedFiles);
  const { behindBase, conflictingFiles, canAutoMerge } = checkBranchStatus(workingDir, baseBranch, changedFiles);

  const mkCtx = (d: string, fc: { path: string; content: string }[]): PrContext => ({
    diff: truncate(d, MAX_DIFF_BYTES),
    changedFiles,
    fileContents: fc,
    behindBase,
    conflictingFiles,
    canAutoMerge,
    incrementalSince,
    newCommits,
  });

  const totalBytes = byteLength(diff) + fileContents.reduce((s, f) => s + byteLength(f.content), 0);
  if (totalBytes > MAX_CONTEXT_BYTES) {
    core.info(`Context exceeds ${MAX_CONTEXT_BYTES} bytes; trimming full file content`);
    const trimmed = fileContents.slice(0, Math.floor(fileContents.length / 2));
    const trimmedTotal = byteLength(diff) + trimmed.reduce((s, f) => s + byteLength(f.content), 0);
    if (trimmedTotal > MAX_CONTEXT_BYTES) {
      core.info('Even trimmed context too large; using diff only');
      return mkCtx(diff, []);
    }
    return mkCtx(diff, trimmed);
  }

  return mkCtx(diff, fileContents);
}

function checkBranchStatus(
  workingDir: string,
  baseBranch: string,
  changedFiles: string[],
): {
  behindBase: { sha: string; message: string }[];
  conflictingFiles: string[];
  canAutoMerge: boolean;
} {
  const behindBaseRaw = runGit(workingDir, ['log', `HEAD..${baseBranch}`, '--oneline', '--no-decorate']);
  const behindBase: { sha: string; message: string }[] = behindBaseRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split(/\s+/);
      return { sha: sha ?? '', message: rest.join(' ').trim() };
    })
    .filter((c) => c.sha);

  core.info(`Branch status: ${behindBase.length} new commits on ${baseBranch} since merge base`);

  if (behindBase.length === 0) {
    return { behindBase: [], conflictingFiles: [], canAutoMerge: true };
  }

  const baseFilesRaw = runGit(workingDir, ['diff', `HEAD...${baseBranch}`, '--name-only']);
  const baseChanged = new Set(
    baseFilesRaw
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
  );

  const conflictingFiles = changedFiles.filter((f) => baseChanged.has(f));

  if (conflictingFiles.length > 0) {
    core.info(`Potential conflict files (changed on both branches): ${conflictingFiles.join(', ')}`);
  }

  const canAutoMerge = dryRunMerge(workingDir, baseBranch);
  if (!canAutoMerge) {
    core.info('Dry-run merge reports conflicts');
  }

  return { behindBase, conflictingFiles, canAutoMerge };
}

function dryRunMerge(workingDir: string, baseBranch: string): boolean {
  const { stdout, status } = runGitAllowFail(workingDir, ['merge-tree', '--write-tree', '--messages', baseBranch, 'HEAD']);
  if (status === 0) return true;
  if (status === 1) return !stdout.includes('CONFLICT');
  return true;
}

function selectFilesForContext(
  workingDir: string,
  changedFiles: string[],
): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = [];

  for (const file of changedFiles) {
    if (result.length >= FULL_FILE_LIMIT) break;
    if (!isTextFile(file)) continue;
    try {
      const full = readFileSync(join(workingDir, file), 'utf-8');
      const content = byteLength(full) > MAX_FILE_BYTES ? full.slice(0, MAX_FILE_BYTES) + '\n… (truncated)' : full;
      result.push({ path: file, content });
    } catch (err) {
      core.info(`Could not read ${file}: ${(err as Error).message}`);
    }
  }

  return result;
}

function isTextFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|scala|sh|bash|zsh|ya?ml|json|toml|ini|cfg|conf|md|txt|tf|helmfile|k8s|ya?ml\.tmpl)$/i.test(path);
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).toString().trim();
  } catch (err) {
    core.warning(`git command failed: git ${args.join(' ')} — ${(err as Error).message}`);
    return '';
  }
}

function runGitAllowFail(cwd: string, args: string[]): { stdout: string; status: number | null } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: (e.stdout ?? '').toString().trim(), status: e.status ?? 1 };
  }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function truncate(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  const half = Math.floor((max - 50) / 2);
  return s.slice(0, half) + `\n… (truncated ${byteLength(s) - max} bytes) …\n` + s.slice(s.length - half);
}

const FENCE = '```';
const SAFER_FENCE = '``````````';

const MAX_PREVIOUS_REVIEW_BYTES = 4000;

export function buildContextPrompt(ctx: PrContext, previousReview?: { sha: string; body: string } | null): string {
  const sections: string[] = [];

  const isFollowUp = !!(previousReview && ctx.incrementalSince);

  if (isFollowUp && previousReview) {
    sections.push(
      `# Follow-up review — verify previous findings, review only new changes`,
      '',
      `You already reviewed this PR at commit \`${previousReview.sha.slice(0, 7)}\`. The context below contains ONLY the changes made since then (${ctx.newCommits.length} new commit(s)). **Do NOT write a full summary again.**`,
      '',
      'Your tasks, in order:',
      '1. Read your previous review below. For every finding you raised (blocker, warning, nit), check the incremental diff: is it **fixed**, **still present**, or **partially fixed**? State the verdict per finding in one short line each.',
      '2. Review the incremental diff as a standalone change: does it introduce NEW problems? Report only NEW findings (severity + file + line as usual).',
      '3. Confirm anything that was clearly done right in response to your feedback in one line (no more).',
      '',
      'Output format for this follow-up (replace the normal Summary/Risk/Architecture sections):',
      '',
      '### Follow-up review',
      '**New changes:** <N commits, one-line description of what they do>',
      '**Previous findings:** <verdict list — e.g. "✅ blocker #1 fixed (contents now read-only)", "⏳ warning #2 still present">',
      '**New findings:** <list, or "None">',
      '',
      'Keep the whole thing under ~15 lines of prose (inline findings excepted). Do not restate the PR description, the architecture overview, or anything you already said.',
      '',
      '## Your previous review',
      '',
      truncate(previousReview.body, MAX_PREVIOUS_REVIEW_BYTES),
    );
  } else {
    sections.push('Review this pull request.');
  }

  sections.push('', '## Pre-collected context', '');
  sections.push(
    isFollowUp
      ? 'The incremental diff (since your last review), changed file contents, and branch status are already included below. Start your review from this context — do NOT re-run git diff or read the changed files again. Use tools only to trace references, verify that previous findings are resolved, or check external documentation that is not shown here.'
      : 'The diff, changed file contents, and branch status are already included below. Start your review from this context — do NOT re-run git diff or read the changed files again. Use tools only to trace references, callers, or verify external documentation that is not shown here.',
  );

  sections.push('', '### Changed files', '');
  if (ctx.changedFiles.length === 0) {
    sections.push('(no changed files)');
  } else {
    for (const f of ctx.changedFiles) sections.push(`- \`${f}\``);
  }

  sections.push('', '### Branch status', '');
  if (ctx.behindBase.length === 0) {
    sections.push('The base branch has no new commits since the merge base. This PR is up to date.');
  } else {
    sections.push(
      `The base branch has **${ctx.behindBase.length}** new commit(s) since the merge base. These may change the context or need for this PR — check whether any of them touch the same areas as this PR.`,
      '',
      'New commits on base:',
    );
    for (const c of ctx.behindBase.slice(0, 15)) {
      sections.push(`- \`${c.sha.slice(0, 7)}\` ${c.message}`);
    }
    if (ctx.behindBase.length > 15) {
      sections.push(`- _…and ${ctx.behindBase.length - 15} more_`);
    }

    if (ctx.conflictingFiles.length > 0) {
      sections.push(
        '',
        `**Files changed in both this PR and the base branch** (${ctx.conflictingFiles.length}, merge conflict risk):`,
      );
      for (const f of ctx.conflictingFiles) sections.push(`- \`${f}\``);
      if (!ctx.canAutoMerge) {
        sections.push('', '**This PR will produce merge conflicts** — a rebase is required. Note this in the review.');
      } else {
        sections.push('', 'A dry-run merge succeeded (no textual conflicts), but the overlapping files may still produce **semantic conflicts** — verify that the base-branch changes do not invalidate or duplicate the PR changes.');
      }
    } else {
      if (ctx.canAutoMerge) {
        sections.push('', 'No overlapping files. A dry-run merge succeeded.');
      } else {
        sections.push('', '**A dry-run merge reports conflicts** even though no file names overlap — investigate with `bash`.');
      }
    }
  }

  if (ctx.incrementalSince) {
    sections.push('', `### New commits since \`${ctx.incrementalSince.slice(0, 7)}\``, '');
    if (ctx.newCommits.length === 0) {
      sections.push('(none)');
    } else {
      for (const c of ctx.newCommits) sections.push(`- \`${c.sha.slice(0, 7)}\` ${c.message}`);
    }
    sections.push('', '### Incremental diff', '', `${FENCE}diff`, truncate(ctx.diff, MAX_DIFF_BYTES), FENCE);
  } else {
    sections.push('', '### Diff', '', `${FENCE}diff`, truncate(ctx.diff, MAX_DIFF_BYTES), FENCE);
  }

  if (ctx.fileContents.length > 0) {
    sections.push('', '### Changed file contents', '');
    for (const f of ctx.fileContents) {
      sections.push('', `#### \`${f.path}\``, '', SAFER_FENCE, f.content, SAFER_FENCE);
    }
  } else {
    sections.push('', '_Full file contents were not pre-loaded (too many changed files or too large). Use \`read\` selectively for the specific lines you need._');
  }

  return sections.join('\n');
}
