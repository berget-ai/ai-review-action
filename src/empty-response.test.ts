import { expect, test } from 'bun:test';
import { describeEmptyResponse, emptyReviewMessage, formatEmptyReason, SKIPPED_MARKER } from './empty-response.js';

test('describeEmptyResponse: given reasoning that hit the output limit, reports length and thinking', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'review' }] },
    { role: 'assistant', content: [{ type: 'thinking' }], stopReason: 'length' },
  ];

  const reason = describeEmptyResponse({ messages });

  expect(reason).toEqual({ stopReason: 'length', blocks: ['thinking'] });
});

test('describeEmptyResponse: given a provider error, includes the error message', () => {
  const messages = [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'terminated' }];

  const reason = describeEmptyResponse({ messages });

  expect(reason).toEqual({ stopReason: 'error', blocks: [], errorMessage: 'terminated' });
});

test('describeEmptyResponse: given several assistant turns, describes the last one', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall' }], stopReason: 'toolUse' },
    { role: 'toolResult', content: [{ type: 'text' }] },
    { role: 'assistant', content: [{ type: 'thinking' }], stopReason: 'length' },
  ];

  const reason = describeEmptyResponse({ messages });

  expect(reason.stopReason).toBe('length');
});

test('describeEmptyResponse: given no assistant message, reports none', () => {
  const reason = describeEmptyResponse({ messages: [{ role: 'user', content: [] }] });

  expect(reason).toEqual({ stopReason: 'none', blocks: [] });
});

test('formatEmptyReason: given an error reason, renders all fields for the log', () => {
  const line = formatEmptyReason({ stopReason: 'error', blocks: ['thinking'], errorMessage: 'terminated' });

  expect(line).toBe('stopReason=error, blocks=[thinking], error=terminated');
});

test('emptyReviewMessage: given the output limit was hit, explains it and suggests splitting', () => {
  const message = emptyReviewMessage({ reason: { stopReason: 'length', blocks: ['thinking'], maxTokens: 8192 } });

  expect(message).toContain(SKIPPED_MARKER);
  expect(message).toContain('the model hit its output limit (8192 tokens)');
  expect(message).toContain('or split the PR');
  expect(message).toContain('`stopReason=length, blocks=[thinking]`');
});

test('emptyReviewMessage: given a provider error, quotes the error', () => {
  const message = emptyReviewMessage({
    reason: { stopReason: 'error', blocks: [], errorMessage: 'terminated' },
  });

  expect(message).toContain('the model provider returned an error: `terminated`. Comment `@berget` to retry.');
});

test('emptyReviewMessage: given any other stop reason, says no review text and shows details', () => {
  const message = emptyReviewMessage({ reason: { stopReason: 'stop', blocks: [] } });

  expect(message).toContain('the model returned no review text. Comment `@berget` to retry.');
  expect(message).toContain('`stopReason=stop, blocks=[]`');
});

test('emptyReviewMessage: given the output limit is unknown, omits the token count', () => {
  const message = emptyReviewMessage({ reason: { stopReason: 'length', blocks: [] } });

  expect(message).toContain('the model hit its output limit before it wrote a review.');
});
