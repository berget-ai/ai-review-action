import { expect, test } from 'bun:test';
import { commentableLines, findingsSection, splitByDiff } from './diff-lines.js';
import type { Finding } from './inline-findings.js';

const PATCH = [
  '@@ -10,4 +10,5 @@ export function a() {',
  ' context one',
  '-removed',
  '+added one',
  '+added two',
  ' context two',
  '@@ -40,2 +41,2 @@',
  ' far context',
  '+far added',
  '\\ No newline at end of file',
].join('\n');

const finding = (file: string, line: number): Finding => ({ file, line, severity: 'nit', message: `${file}:${line}` });

test('commentableLines: given a patch, returns the new-side lines of added and context rows', () => {
  const lines = commentableLines(PATCH);

  expect([...lines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 41, 42]);
});

test('commentableLines: given no patch, returns no lines', () => {
  expect(commentableLines(undefined).size).toBe(0);
});

test('splitByDiff: given findings on and off the diff, separates them', () => {
  const files = [{ filename: 'src/a.ts', patch: PATCH }];
  const findings = [finding('src/a.ts', 11), finding('src/a.ts', 30), finding('README.md', 1)];

  const { inDiff, outside } = splitByDiff(findings, files);

  expect(inDiff).toEqual([finding('src/a.ts', 11)]);
  expect(outside).toEqual([finding('src/a.ts', 30), finding('README.md', 1)]);
});

test('findingsSection: given no findings, returns an empty string', () => {
  expect(findingsSection([])).toBe('');
});

test('findingsSection: given findings, lists each with its location and severity', () => {
  const section = findingsSection([finding('README.md', 81)]);

  expect(section).toContain('### Findings not posted inline');
  expect(section).toContain('- `README.md:81` 🟡 **nit** — README.md:81');
});
