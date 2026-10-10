import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPlaywrightKeys } from './src/agent.js';
import { DEFAULT_POLICY, needsCheck, verdictFor } from './src/brake.js';

test('only actions that can change something are checked', () => {
  assert.equal(needsCheck({ type: 'click', x: 1, y: 1 }), true);
  assert.equal(needsCheck({ type: 'type', text: 'prod-main' }), true);
  assert.equal(needsCheck({ type: 'keypress', keys: ['ENTER'] }), true);
  assert.equal(needsCheck({ type: 'keypress', keys: ['CTRL', 'A'] }), false);
  assert.equal(needsCheck({ type: 'scroll', x: 0, y: 0, scroll_x: 0, scroll_y: 300 }), false);
  assert.equal(needsCheck({ type: 'wait' }), false);
});

test('policy decides; unknown labels ask a human', () => {
  assert.equal(verdictFor('safe'), 'allow');
  assert.equal(verdictFor('delete'), 'ask');
  assert.equal(verdictFor('delete', { ...DEFAULT_POLICY, delete: 'block' }), 'block');
  assert.equal(verdictFor('something-new'), 'ask');
});

test('model key names map to Playwright', () => {
  assert.equal(toPlaywrightKeys(['CTRL', 'A']), 'Control+A');
  assert.equal(toPlaywrightKeys(['ENTER']), 'Enter');
  assert.equal(toPlaywrightKeys(['a']), 'a');
});
