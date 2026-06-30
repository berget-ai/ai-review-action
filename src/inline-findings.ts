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

const FENCE_PATTERN = /```ai-review-findings\s*\n([\s\S]*?)\n```\s*$/;

/**
 * Extract the JSON findings block from the review body.
 * Returns `{ findings, bodyWithoutFindings }`. If no block is present,
 * `findings` is an empty array and `bodyWithoutFindings` is the original body.
 */
export function extractFindings(body: string): {
  findings: Finding[];
  bodyWithoutFindings: string;
} {
  const match = body.match(FENCE_PATTERN);
  if (!match) {
    return { findings: [], bodyWithoutFindings: body };
  }

  const jsonText = match[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    core.warning(`Failed to parse ai-review-findings JSON: ${(err as Error).message}`);
    return { findings: [], bodyWithoutFindings: body.slice(0, match.index).trimEnd() };
  }

  if (!Array.isArray(parsed)) {
    core.warning('ai-review-findings JSON is not an array');
    return { findings: [], bodyWithoutFindings: body.slice(0, match.index).trimEnd() };
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
    bodyWithoutFindings: body.slice(0, match.index).trimEnd(),
  };
}

/**
 * Format a finding as the markdown body for a GitHub line comment.
 */
export function formatFindingComment(f: Finding): string {
  return `${SEVERITY_EMOJI[f.severity]} **${f.severity}** — ${f.message}`;
}
