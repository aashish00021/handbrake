#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { runAgent } from './src/agent.js';
import { DEFAULT_POLICY } from './src/brake.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string', default: 'about:blank' }, policy: { type: 'string', default: 'handbrake.json' } },
});
const task = positionals.join(' ');
if (!task) {
  console.error('usage: handbrake "<task>" [--url https://...] [--policy handbrake.json]');
  process.exit(1);
}

const policy = { ...DEFAULT_POLICY, ...JSON.parse(await readFile(values.policy, 'utf8').catch(() => '{}')) };

// The human answers here, in the terminal: a channel the agent can't reach.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const approve = async ({ action, label, reason, target }) => {
  const answer = await rl.question(`\n\x1b[41m HANDBRAKE \x1b[0m ${label.toUpperCase()} (${reason})\n  the agent wants to: ${target}\n  allow? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
};

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(values.url);

try {
  const result = await runAgent(page, task, { approve, policy, onStep: (a) => console.log('·', a.type, a.text ?? a.keys ?? (a.x != null ? `${a.x},${a.y}` : '')) });
  console.log(`\n${result}`);
} finally {
  rl.close();
  await browser.close();
}
