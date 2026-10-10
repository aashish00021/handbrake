import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPlaywrightKeys } from './src/agent.js';
import { DEFAULT_POLICY, judge, needsCheck, verdictFor } from './src/brake.js';

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

test('judge fails closed and distrusts a shaky "safe"', async () => {
  const reply = (body, ok = true) => { globalThis.fetch = async () => ({ ok, status: ok ? 200 : 401, json: async () => body, text: async () => 'nope' }); };
  const png = Buffer.from('');
  const choice = (choice, probability) => ({ answers: [{ type: 'choice', choice, probabilities: [{ value: choice, probability }] }] });

  reply(choice('delete', 0.97));
  assert.equal((await judge(png, {})).label, 'delete');
  reply(choice('safe', 0.95));
  assert.equal((await judge(png, {})).label, 'safe');
  reply(choice('safe', 0.6));
  assert.equal((await judge(png, {})).label, 'unsure');
  assert.equal((await judge(png, { type: 'type', text: 'prod-main' })).label, 'safe');
  reply({}, false);
  assert.equal((await judge(png, {})).label, 'unsure');
  reply({ answers: [{ type: 'refusal' }] });
  assert.equal((await judge(png, {})).label, 'unsure');
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await judge(png, {})).label, 'unsure');
});

test('chat judge reads one word from any OpenAI-compatible model', async () => {
  process.env.HANDBRAKE_JUDGE = 'chat';
  const say = (content) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }); };
  try {
    say('delete');
    assert.equal((await judge(Buffer.from(''), {})).label, 'delete');
    say('Purchase.');
    assert.equal((await judge(Buffer.from(''), {})).label, 'purchase');
    say('I think this is fine');
    assert.equal((await judge(Buffer.from(''), {})).label, 'unsure');
  } finally {
    delete process.env.HANDBRAKE_JUDGE;
  }
});
