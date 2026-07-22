import { execSync } from 'child_process';
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
};

const FULL_FILE_LIMIT = 3;
const MAX_FILE_BYTES = 30_000;
const MAX_DIFF_BYTES = 60_000;
const MAX_CONTEXT_BYTES = 80_000;

export function gatherPrContext({ workingDir, baseBranch }: PrContextOptions): PrContext {
  const diff = runGit(workingDir, [
    'diff',
    `${baseBranch}...HEAD`,
    '--',
    ':!*.lock',
    ':!*lock.json',
    ':!*.svg',
    ':!*.png',
  ]);

  const changedFiles = runGit(workingDir, [
    'diff',
    `${baseBranch}...HEAD`,
    '--name-only',
  ])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  core.info(`PR context: ${changedFiles.length} changed files, ${diff.length} diff bytes`);

  const fileContents = selectFilesForContext(workingDir, changedFiles);

  const totalBytes = diff.length + fileContents.reduce((s, f) => s + f.content.length, 0);
  if (totalBytes > MAX_CONTEXT_BYTES) {
    core.info(`Context exceeds ${MAX_CONTEXT_BYTES} bytes; trimming full file content`);
    const trimmed = fileContents.slice(0, Math.floor(fileContents.length / 2));
    const trimmedTotal = diff.length + trimmed.reduce((s, f) => s + f.content.length, 0);
    if (trimmedTotal > MAX_CONTEXT_BYTES) {
      core.info('Even trimmed context too large; using diff only');
      return { diff: truncate(diff, MAX_DIFF_BYTES), changedFiles, fileContents: [] };
    }
    return { diff: truncate(diff, MAX_DIFF_BYTES), changedFiles, fileContents: trimmed };
  }

  return { diff: truncate(diff, MAX_DIFF_BYTES), changedFiles, fileContents };
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
      const content = full.length > MAX_FILE_BYTES ? full.slice(0, MAX_FILE_BYTES) + '\n… (truncated)' : full;
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
    return execSync(`git ${args.map(shellQuote).join(' ')}`, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).toString().trim();
  } catch (err) {
    core.warning(`git command failed: git ${args.join(' ')} — ${(err as Error).message}`);
    return '';
  }
}

function shellQuote(arg: string): string {
  if (/^[\w@./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 50) / 2);
  return s.slice(0, half) + `\n… (truncated ${s.length - max} bytes) …\n` + s.slice(s.length - half);
}

export function buildContextPrompt(ctx: PrContext): string {
  const sections: string[] = ['Review this pull request.'];

  sections.push('', '## Pre-collected context', '');
  sections.push(
    'The diff and changed file contents are already included below. Start your review from this context — do NOT re-run git diff or read the changed files again. Use tools only to trace references, callers, or verify external documentation that is not shown here.',
  );

  sections.push('', '### Changed files', '');
  if (ctx.changedFiles.length === 0) {
    sections.push('(no changed files)');
  } else {
    for (const f of ctx.changedFiles) sections.push(`- \`${f}\``);
  }

  sections.push('', '### Diff', '', '```diff', truncate(ctx.diff, MAX_DIFF_BYTES), '```');

  if (ctx.fileContents.length > 0) {
    sections.push('', '### Changed file contents', '');
    for (const f of ctx.fileContents) {
      sections.push('', `#### \`${f.path}\``, '', '```', f.content, '```');
    }
  } else {
    sections.push('', '_Full file contents were not pre-loaded (too many changed files or too large). Use \`read\` selectively for the specific lines you need._');
  }

  return sections.join('\n');
}
