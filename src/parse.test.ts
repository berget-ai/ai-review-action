import { expect, test } from 'bun:test';
import { parseReviewTrigger, parseMentionTrigger, containsPiMention } from './parse.js';

test('parseReviewTrigger: @berget review', () => {
  expect(parseReviewTrigger({ body: '@berget review' })).toEqual({ command: 'review', message: '' });
});

test('parseReviewTrigger: message captured', () => {
  expect(parseReviewTrigger({ body: '@berget review focus on error handling' })).toEqual({
    command: 'review',
    message: 'focus on error handling',
  });
});

test('parseReviewTrigger: legacy @pi alias still works', () => {
  expect(parseReviewTrigger({ body: '@pi review' })).toEqual({ command: 'review', message: '' });
});

test('parseReviewTrigger: bare mention without "review" is not a trigger', () => {
  expect(parseReviewTrigger({ body: '@berget' })).toBeNull();
  expect(parseReviewTrigger({ body: '@berget hello there' })).toBeNull();
});

test('parseReviewTrigger: must start the comment body', () => {
  expect(parseReviewTrigger({ body: 'please @berget review' })).toBeNull();
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

test('parseMentionTrigger: capture after mention', () => {
  expect(parseMentionTrigger({ body: 'hej @berget vad gör Cluster?', command: 'issue' })).toEqual({
    command: 'issue',
    message: 'vad gör Cluster?',
  });
});

test('parseMentionTrigger: review body is not a mention', () => {
  expect(parseMentionTrigger({ body: '@berget review', command: 'comment' })).toBeNull();
});
