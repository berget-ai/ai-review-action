import type { ParsedTrigger } from './types.js';

// A PR comment of exactly "@berget [optional message]" (or legacy "@pi")
// triggers a review. A leading "review" word is optional sugar, so these
// are equivalent: "@berget", "@berget review", "@berget review focus on X".
// Any other text ("@berget what does this do?") is a chat mention instead.
const REVIEW_PATTERN = /^@(?:berget|pi)(?![\w.\-])(?:\s+(.*))?$/is;

// Matches "@berget" (or legacy "@pi") followed by an optional message anywhere
// in the body. Negative lookahead excludes @berget.ai / @berget-ai-daily etc.
const MENTION_PATTERN = /@(?:berget|pi)(?![\w.\-])(?:\s+(.*))?$/is;

export function parseReviewTrigger({ body }: { body: string }): ParsedTrigger | null {
  const trimmed = body.trim();
  const match = trimmed.match(REVIEW_PATTERN);
  if (!match) return null;

  let message = (match[1] ?? '').trim();
  if (message.toLowerCase() === 'review') return { command: 'review', message: '' };
  const reviewWord = message.match(/^review\b\s*(.*)$/is);
  if (reviewWord) message = (reviewWord[1] ?? '').trim();
  else if (message !== '') return null; // "@berget <question>" → chat mention, not review

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

  // If the body is a review trigger it's a review trigger, not a general mention
  if (REVIEW_PATTERN.test(trimmed)) return null;

  const match = trimmed.match(MENTION_PATTERN);
  if (!match) return null;

  return { command, message: match[1]?.trim() ?? '' };
}

export function containsPiMention({ body }: { body: string }): boolean {
  return /@(?:berget|pi)(?![\w.\-])/i.test(body);
}
