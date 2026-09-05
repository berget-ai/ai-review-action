import type { ParsedTrigger } from './types.js';

// Matches "@berget review [optional message]" -- only valid on PR comments.
// "@pi review" is accepted as a legacy alias.
const REVIEW_PATTERN = /^@(?:berget|pi)\s+review(?:\s+(.*))?$/is;

// Matches "@berget" (or legacy "@pi") followed by an optional message anywhere
// in the body
const MENTION_PATTERN = /@(?:berget|pi)(?:\s+(.*))?$/is;

export function parseReviewTrigger({ body }: { body: string }): ParsedTrigger | null {
  const trimmed = body.trim();
  const match = trimmed.match(REVIEW_PATTERN);
  if (!match) return null;
  return { command: 'review', message: match[1]?.trim() ?? '' };
}

export function parseMentionTrigger({
  body,
  command,
}: {
  body: string;
  command: 'comment' | 'issue' | 'discussion';
}): ParsedTrigger | null {
  const trimmed = body.trim();

  // If the body is exactly "@berget review ..." it's a review trigger, not a general mention
  if (REVIEW_PATTERN.test(trimmed)) return null;

  const match = trimmed.match(MENTION_PATTERN);
  if (!match) return null;

  return { command, message: match[1]?.trim() ?? '' };
}

export function containsPiMention({ body }: { body: string }): boolean {
  return /@(?:berget|pi)\b/i.test(body);
}
