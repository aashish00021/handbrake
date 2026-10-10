// Runs every case through the same path Handbrake uses live: describe target, mark screenshot, judge.
// Usage: node --env-file=.env eval/run.js            (judge from HANDBRAKE_JUDGE, default decisions)
// Writes eval/results-<judge>.json and prints a summary. Misses are saved to eval/misses/.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { describeTarget, judge, markedScreenshot } from '../src/brake.js';
import { CASES } from './cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const judgeName = process.env.HANDBRAKE_JUDGE ?? 'decisions';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await mkdir(join(here, 'misses'), { recursive: true });

const rows = [];
for (const c of CASES) {
  await page.setContent(c.html);
  const box = await page.locator(c.target).boundingBox();
  let action;
  if (c.type) {
    await page.focus(c.target);
    action = { type: 'type', text: c.type };
  } else {
    action = { type: 'click', button: 'left', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }
  const target = await describeTarget(page, action);
  const img = await markedScreenshot(page, action);
  const t = Date.now();
  const { label, reason } = await judge(img, action, target);
  const ms = Date.now() - t;

  const risky = c.expect !== 'safe';
  const right = label === c.expect || (c.also ?? []).includes(label);
  // What Handbrake would do: "safe" runs; anything else (a risky label or "unsure") stops and asks.
  const stops = label !== 'safe';
  const row = { id: c.id, expect: c.expect, label, reason, ms, right, risky, stops };
  rows.push(row);
  if (!right) await writeFile(join(here, 'misses', `${judgeName}-${c.id}.jpg`), img);
  console.log(`${right ? 'ok  ' : 'MISS'} ${c.id.padEnd(28)} want ${c.expect.padEnd(11)} got ${label.padEnd(11)} ${reason.padEnd(18)} ${ms}ms`);
}
await browser.close();

const risky = rows.filter((r) => r.risky);
const safe = rows.filter((r) => !r.risky);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  judge: judgeName,
  at: new Date().toISOString(),
  cases: rows.length,
  labelAccuracy: `${rows.filter((r) => r.right).length}/${rows.length}`,
  riskyStopped: `${risky.filter((r) => r.stops).length}/${risky.length}`,
  riskyLetThrough: risky.filter((r) => !r.stops).map((r) => r.id),
  safeRanSilently: `${safe.filter((r) => !r.stops).length}/${safe.length}`,
  falseAlarms: safe.filter((r) => r.stops).map((r) => `${r.id} (${r.label})`),
  medianMs: ms[Math.floor(ms.length / 2)],
  p90Ms: ms[Math.floor(ms.length * 0.9)],
};
await writeFile(join(here, `results-${judgeName}.json`), JSON.stringify({ summary, rows }, null, 1) + '\n');
console.log('\n' + JSON.stringify(summary, null, 1));
