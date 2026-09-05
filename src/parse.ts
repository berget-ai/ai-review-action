import type { ParsedTrigger } from './types.js';

// Trigger semantics (PR comments):
//   "@berget"            → review (incremental)
//   "@berget review"     → same, "review" is optional sugar
//   "@berget <text>"     → review with <text> as focus (a leading "review"
//                          word is stripped)
// "@pi" is a legacy alias for "@berget" everywhere.
//
// Mention semantics (inline file comments, issues, discussions):
//   any body containing "@berget <question>" that is NOT a review trigger.
//
// The negative lookahead excludes @berget.ai / @berget-ai-daily etc.
const MENTION_PATTERN = /@(?:berget|pi)(?![\w.\-])(?:\s+(.*))?$/is;

// True when the whole body is a review trigger: bare mention, or mention
// followed by a "review" keyword (optionally with a focus message).
function isReviewTriggerBody(trimmed: string): boolean {
  return (
    /^@(?:berget|pi)(?![\w.\-])\s*$/i.test(trimmed) ||
    /^@(?:berget|pi)(?![\w.\-])\s+review\b/i.test(trimmed)
  );
}

export function parseReviewTrigger({ body }: { body: string }): ParsedTrigger | null {
  const trimmed = body.trim();
  const match = trimmed.match(/^@(?:berget|pi)(?![\w.\-])(?:\s+(.*))?$/is);
  if (!match) return null;

  let message = (match[1] ?? '').trim();
  const reviewWord = message.match(/^review\b\s*(.*)$/is);
  if (reviewWord) message = (reviewWord[1] ?? '').trim();
  // Anything remaining is the review focus — "@berget focus on X" and
  // "@berget review focus on X" are equivalent.

  return { command: 'review', message };
}

export function parseMentionTrigger({
  body,
  command,
}: {
  body: string;
  command: 'comment' | 'issue' | 'discussion';
}): ParsedTrigger | null {
  const trimmed = body.trim();

  // A review trigger body is not a general chat mention.
  if (isReviewTriggerBody(trimmed)) return null;

  const match = trimmed.match(MENTION_PATTERN);
  if (!match) return null;

  return { command, message: (match[1] ?? '').trim() };
}

export function containsPiMention({ body }: { body: string }): boolean {
  return /@(?:berget|pi)(?![\w.\-])/i.test(body);
}
