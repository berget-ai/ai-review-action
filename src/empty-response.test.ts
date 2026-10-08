import { expect, test } from 'bun:test';
import { describeEmptyResponse } from './empty-response.js';

test('describeEmptyResponse: reasoning that hit the output limit', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'review' }] },
    { role: 'assistant', content: [{ type: 'thinking' }], stopReason: 'length' },
  ];

  expect(describeEmptyResponse({ messages })).toBe('stopReason=length, blocks=[thinking]');
});

test('describeEmptyResponse: provider error is included', () => {
  const messages = [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'terminated' }];

  expect(describeEmptyResponse({ messages })).toBe('stopReason=error, blocks=[], error=terminated');
});

test('describeEmptyResponse: describes the last assistant message, not an earlier one', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall' }], stopReason: 'toolUse' },
    { role: 'toolResult', content: [{ type: 'text' }] },
    { role: 'assistant', content: [{ type: 'thinking' }], stopReason: 'length' },
  ];

  expect(describeEmptyResponse({ messages })).toBe('stopReason=length, blocks=[thinking]');
});

test('describeEmptyResponse: no assistant message at all', () => {
  expect(describeEmptyResponse({ messages: [{ role: 'user', content: [] }] })).toBe('no assistant message');
});
