import { formatFindingComment, type Finding } from './inline-findings.js';

export interface ChangedFile {
  filename: string;
  /** Absent for binary files and diffs GitHub considers too large. */
  patch?: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * New-side line numbers GitHub accepts for a RIGHT-side review comment:
 * every added or context row inside a hunk of the file's patch.
 */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const row of (patch ?? '').split('\n')) {
    const header = row.match(HUNK_HEADER);
    if (header) {
      next = Number(header[1]);
      continue;
    }
    if (next === 0 || row.startsWith('-') || row.startsWith('\\')) continue;
    lines.add(next);
    next++;
  }
  return lines;
}

export function splitByDiff(
  findings: Finding[],
  files: ChangedFile[],
): { inDiff: Finding[]; outside: Finding[] } {
  const byFile = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));
  const inDiff: Finding[] = [];
  const outside: Finding[] = [];
  for (const f of findings) {
    (byFile.get(f.file)?.has(f.line) ? inDiff : outside).push(f);
  }
  return { inDiff, outside };
}

/** Markdown for findings that cannot be posted as line comments. */
export function findingsSection(findings: Finding[]): string {
  if (findings.length === 0) return '';
  const rows = findings.map((f) => `- \`${f.file}:${f.line}\` ${formatFindingComment(f)}`);
  return ['### Findings not posted inline', '', ...rows].join('\n');
}
