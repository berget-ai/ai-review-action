import { expect, test } from 'bun:test';
import { parseReviewTrigger, parseMentionTrigger, containsPiMention } from './parse.js';

test('parseReviewTrigger: bare @berget triggers review', () => {
  expect(parseReviewTrigger({ body: '@berget' })).toEqual({ command: 'review', message: '' });
});

test('parseReviewTrigger: @berget review is equivalent sugar', () => {
  expect(parseReviewTrigger({ body: '@berget review' })).toEqual({ command: 'review', message: '' });
});

test('parseReviewTrigger: focus message, with and without review keyword', () => {
  expect(parseReviewTrigger({ body: '@berget focus on error handling' })).toEqual({
    command: 'review',
    message: 'focus on error handling',
  });
  expect(parseReviewTrigger({ body: '@berget review focus on error handling' })).toEqual({
    command: 'review',
    message: 'focus on error handling',
  });
});

test('parseReviewTrigger: questions on a PR comment become review focus', () => {
  // PR-level comments route only through the review handler; any text after
  // the mention narrows the review rather than starting a chat.
  expect(parseReviewTrigger({ body: '@berget what do you think?' })).toEqual({
    command: 'review',
    message: 'what do you think?',
  });
});

test('parseReviewTrigger: legacy @pi alias still works', () => {
  expect(parseReviewTrigger({ body: '@pi' })).toEqual({ command: 'review', message: '' });
  expect(parseReviewTrigger({ body: '@pi review' })).toEqual({ command: 'review', message: '' });
});

test('parseReviewTrigger: must start the comment body', () => {
  expect(parseReviewTrigger({ body: 'please @berget review' })).toBeNull();
});

test('parseReviewTrigger: does not match domains or longer handles', () => {
  expect(parseReviewTrigger({ body: '@berget.ai review' })).toBeNull();
  expect(parseReviewTrigger({ body: '@berget-ai-daily review' })).toBeNull();
});

test('parseMentionTrigger: capture question after mention', () => {
  expect(parseMentionTrigger({ body: 'hej @berget vad gör Cluster?', command: 'issue' })).toEqual({
    command: 'issue',
    message: 'vad gör Cluster?',
  });
});

test('parseMentionTrigger: question STARTING with the mention still works', () => {
  expect(parseMentionTrigger({ body: '@berget is this safe to call concurrently?', command: 'comment' })).toEqual({
    command: 'comment',
    message: 'is this safe to call concurrently?',
  });
});

test('parseMentionTrigger: review trigger bodies are not mentions', () => {
  expect(parseMentionTrigger({ body: '@berget', command: 'comment' })).toBeNull();
  expect(parseMentionTrigger({ body: '@berget review', command: 'comment' })).toBeNull();
  expect(parseMentionTrigger({ body: '@berget review focus on X', command: 'comment' })).toBeNull();
});

test('containsPiMention: matches plain mentions', () => {
  expect(containsPiMention({ body: 'hej @berget kolla detta' })).toBe(true);
  expect(containsPiMention({ body: '@pi' })).toBe(true);
});

test('containsPiMention: does not match domains or longer handles', () => {
  expect(containsPiMention({ body: 'user@berget.ai what?' })).toBe(false);
  expect(containsPiMention({ body: 'kolla @berget-ai-daily' })).toBe(false);
  expect(containsPiMention({ body: 'no mention here' })).toBe(false);
});
