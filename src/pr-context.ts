import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as core from '@actions/core';

export type PrContextOptions = {
  workingDir: string;
  baseBranch: string;
};

export type PrContext = {
  diff: string;
  changedFiles: string[];
  fileContents: { path: string; content: string }[];
  behindBase: { sha: string; message: string }[];
  conflictingFiles: string[];
  canAutoMerge: boolean;
};

const FULL_FILE_LIMIT = 3;
const MAX_FILE_BYTES = 30_000;
const MAX_DIFF_BYTES = 60_000;
const MAX_CONTEXT_BYTES = 80_000;

const DIFF_EXCLUDES = [':!*.lock', ':!*lock.json', ':!*.svg', ':!*.png'];

export function gatherPrContext({ workingDir, baseBranch }: PrContextOptions): PrContext {
  const diffArgs = ['diff', `${baseBranch}...HEAD`, '--', ...DIFF_EXCLUDES];
  const diff = runGit(workingDir, diffArgs);

  const changedFiles = runGit(workingDir, ['diff', `${baseBranch}...HEAD`, '--name-only', '--', ...DIFF_EXCLUDES])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  core.info(`PR context: ${changedFiles.length} changed files, ${byteLength(diff)} diff bytes`);

  const fileContents = selectFilesForContext(workingDir, changedFiles);
  const { behindBase, conflictingFiles, canAutoMerge } = checkBranchStatus(workingDir, baseBranch, changedFiles);

  const totalBytes = byteLength(diff) + fileContents.reduce((s, f) => s + byteLength(f.content), 0);
  if (totalBytes > MAX_CONTEXT_BYTES) {
    core.info(`Context exceeds ${MAX_CONTEXT_BYTES} bytes; trimming full file content`);
    const trimmed = fileContents.slice(0, Math.floor(fileContents.length / 2));
    const trimmedTotal = byteLength(diff) + trimmed.reduce((s, f) => s + byteLength(f.content), 0);
    if (trimmedTotal > MAX_CONTEXT_BYTES) {
      core.info('Even trimmed context too large; using diff only');
      return { diff: truncate(diff, MAX_DIFF_BYTES), changedFiles, fileContents: [], behindBase, conflictingFiles, canAutoMerge };
    }
    return { diff: truncate(diff, MAX_DIFF_BYTES), changedFiles, fileContents: trimmed, behindBase, conflictingFiles, canAutoMerge };
  }

  return { diff: truncate(diff, MAX_DIFF_BYTES), changedFiles, fileContents, behindBase, conflictingFiles, canAutoMerge };
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

export function buildContextPrompt(ctx: PrContext): string {
  const sections: string[] = ['Review this pull request.'];

  sections.push('', '## Pre-collected context', '');
  sections.push(
    'The diff, changed file contents, and branch status are already included below. Start your review from this context — do NOT re-run git diff or read the changed files again. Use tools only to trace references, callers, or verify external documentation that is not shown here.',
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

  sections.push('', '### Diff', '', `${FENCE}diff`, truncate(ctx.diff, MAX_DIFF_BYTES), FENCE);

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
