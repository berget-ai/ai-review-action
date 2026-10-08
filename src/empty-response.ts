type AssistantMessage = {
  role?: string;
  content?: Array<{ type?: string }>;
  stopReason?: string;
  errorMessage?: string;
};

/**
 * Explain why the last assistant message carried no text, e.g.
 * "stopReason=length, blocks=[thinking]" when reasoning used up the output budget.
 */
export function describeEmptyResponse({ messages }: { messages: readonly unknown[] }): string {
  const last = [...messages]
    .reverse()
    .find((m) => (m as AssistantMessage | undefined)?.role === 'assistant') as AssistantMessage | undefined;
  if (!last) return 'no assistant message';

  const blocks = Array.isArray(last.content) ? last.content.map((c) => c.type ?? '?') : [];
  const parts = [`stopReason=${last.stopReason ?? 'unknown'}`, `blocks=[${blocks.join(', ')}]`];
  if (last.errorMessage) parts.push(`error=${last.errorMessage}`);
  return parts.join(', ');
}
