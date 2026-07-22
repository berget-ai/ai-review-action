import * as core from '@actions/core';

export type Severity = 'blocker' | 'warning' | 'nit' | 'good';

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  blocker: '🔴',
  warning: '🟠',
  nit: '🟡',
  good: '✅',
};

const FENCE_PATTERN = /```ai-review-findings[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*/g;

/**
 * Extract the JSON findings block from the review body.
 *
 * Matches the LAST ```ai-review-findings fenced code block anywhere in the body.
 * The model sometimes appends prose after the block (e.g. "Let me know if..."),
 * and the block does not have to be the very last thing in the message.
 *
 * Returns `{ findings, bodyWithoutFindings }`. If no block is present,
 * `findings` is an empty array and `bodyWithoutFindings` is the original body.
 */
export function extractFindings(body: string): {
  findings: Finding[];
  bodyWithoutFindings: string;
} {
  // Find all matches and take the last one; the model occasionally emits a
  // reference snippet in the prose before the real block at the end.
  const matches = [...body.matchAll(FENCE_PATTERN)];
  const match = matches.length > 0 ? matches[matches.length - 1] : null;
  if (!match) {
    return { findings: [], bodyWithoutFindings: body };
  }

  const jsonText = match[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    core.warning(`Failed to parse ai-review-findings JSON: ${(err as Error).message}`);
    return { findings: [], bodyWithoutFindings: stripBlock(body, match.index!, match[0].length) };
  }

  if (!Array.isArray(parsed)) {
    core.warning('ai-review-findings JSON is not an array');
    return { findings: [], bodyWithoutFindings: stripBlock(body, match.index!, match[0].length) };
  }

  const findings: Finding[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).file === 'string' &&
      typeof (item as Record<string, unknown>).line === 'number' &&
      typeof (item as Record<string, unknown>).severity === 'string' &&
      typeof (item as Record<string, unknown>).message === 'string'
    ) {
      const sev = (item as Record<string, unknown>).severity as Severity;
      if (!(sev in SEVERITY_EMOJI)) {
        core.warning(`Unknown severity: ${sev}`);
        continue;
      }
      findings.push({
        file: (item as Record<string, unknown>).file as string,
        line: (item as Record<string, unknown>).line as number,
        severity: sev,
        message: (item as Record<string, unknown>).message as string,
      });
    }
  }

  core.info(`Extracted ${findings.length} inline findings from review`);
  return {
    findings,
    bodyWithoutFindings: stripBlock(body, match.index!, match[0].length),
  };
}

function stripBlock(body: string, index: number, length: number): string {
  return (body.slice(0, index) + body.slice(index + length)).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Format a finding as the markdown body for a GitHub line comment.
 */
export function formatFindingComment(f: Finding): string {
  return `${SEVERITY_EMOJI[f.severity]} **${f.severity}** — ${f.message}`;
}
