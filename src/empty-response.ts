export type EmptyReason = {
  stopReason: string;
  blocks: string[];
  errorMessage?: string;
  maxTokens?: number;
};

type AssistantMessage = {
  role?: string;
  content?: Array<{ type?: string }>;
  stopReason?: string;
  errorMessage?: string;
};

export const SKIPPED_MARKER = '<!-- ai-review-skipped -->';

const ERROR_MAX = 300;

/** Why the last assistant message carried no text, e.g. reasoning used up the output budget. */
export function describeEmptyResponse({ messages }: { messages: readonly unknown[] }): EmptyReason {
  const last = [...messages]
    .reverse()
    .find((m) => (m as AssistantMessage | undefined)?.role === 'assistant') as AssistantMessage | undefined;
  if (!last) return { stopReason: 'none', blocks: [] };

  return {
    stopReason: last.stopReason ?? 'unknown',
    blocks: Array.isArray(last.content) ? last.content.map((c) => c.type ?? '?') : [],
    ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}),
  };
}

export function formatEmptyReason(reason: EmptyReason): string {
  const parts = [`stopReason=${reason.stopReason}`, `blocks=[${reason.blocks.join(', ')}]`];
  if (reason.errorMessage) parts.push(`error=${reason.errorMessage.slice(0, ERROR_MAX)}`);
  return parts.join(', ');
}

export function emptyReviewMessage({ reason }: { reason: EmptyReason }): string {
  const retry = 'Comment `@berget` to retry';
  const limit = reason.maxTokens ? ` (${reason.maxTokens} tokens)` : '';
  const cause =
    reason.stopReason === 'length'
      ? `the model hit its output limit${limit} before it wrote a review. This tends to happen on large diffs. ${retry}, or split the PR.`
      : reason.stopReason === 'error'
        ? `the model provider returned an error: \`${(reason.errorMessage ?? 'unknown').slice(0, ERROR_MAX)}\`. ${retry}.`
        : `the model returned no review text. ${retry}.`;

  return [
    SKIPPED_MARKER,
    `**AI review skipped**: ${cause}`,
    '',
    `<sub>Details: \`${formatEmptyReason(reason)}\`</sub>`,
  ].join('\n');
}
