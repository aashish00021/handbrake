import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';

// What a gated action can do. "safe" covers everything harmless.
export const LABELS = ['safe', 'purchase', 'delete', 'send', 'credentials', 'settings'];

export const DEFAULT_POLICY = {
  safe: 'allow',
  purchase: 'ask',
  delete: 'ask',
  send: 'ask',
  credentials: 'ask',
  settings: 'ask',
};

// Only actions that can change something get checked. Scroll, move, wait never do.
export function needsCheck(action) {
  if (action.type === 'click' || action.type === 'double_click' || action.type === 'type') return true;
  if (action.type === 'keypress') return action.keys.some((k) => /^(enter|return)$/i.test(k));
  return false;
}

export function verdictFor(label, policy = DEFAULT_POLICY) {
  return policy[label] ?? 'ask'; // unknown label: ask a human
}

const QUESTION =
  'A browser agent is about to act on this page. The red ring marks where it will click; ' +
  'a red outline marks the field it will type into or submit. ' +
  'What happens if the action goes ahead? ' +
  'purchase = spends money or places an order; delete = permanently removes data, a resource or an account; ' +
  'send = sends, posts or publishes something to other people; credentials = enters or submits a password, ' +
  'card number, token or secret; settings = changes account, security, billing or permission settings; ' +
  'safe = none of these.';

// Draw the marker on the live page, screenshot, remove it.
export async function markedScreenshot(page, action) {
  await page.evaluate(({ x, y }) => {
    const el = document.createElement('div');
    el.id = '__handbrake_marker';
    const s = el.style;
    s.position = 'fixed';
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    s.border = '4px solid red';
    if (x != null) {
      Object.assign(s, { left: `${x - 22}px`, top: `${y - 22}px`, width: '44px', height: '44px', borderRadius: '50%' });
    } else {
      const r = (document.activeElement ?? document.body).getBoundingClientRect();
      Object.assign(s, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    }
    document.body.appendChild(el);
  }, { x: action.x, y: action.y });
  const png = await page.screenshot();
  await page.evaluate(() => document.getElementById('__handbrake_marker')?.remove());
  return png;
}

let client;

// ponytail: judge via Responses + strict enum; swap to the Decisions API once its request shape is confirmed
async function judge(png, action) {
  client ??= new OpenAI();
  const res = await client.responses.create({
    model: process.env.HANDBRAKE_JUDGE_MODEL ?? 'gpt-6.1-sol',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `${QUESTION}\nPending action: ${JSON.stringify(action)}` },
        { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
      ],
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'verdict',
        strict: true,
        schema: {
          type: 'object',
          properties: { label: { type: 'string', enum: LABELS }, reason: { type: 'string' } },
          required: ['label', 'reason'],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.parse(res.output_text);
}

// Returns true if the action may run. Every checked action is logged with its screenshot.
export async function brake(page, action, { policy = DEFAULT_POLICY, approve, logDir = 'handbrake-log' } = {}) {
  const started = Date.now();
  const png = await markedScreenshot(page, action);
  const { label, reason } = await judge(png, action);
  const ms = Date.now() - started;
  let verdict = verdictFor(label, policy);
  if (verdict === 'ask') verdict = (await approve({ action, label, reason, png })) ? 'approved' : 'denied';

  await mkdir(logDir, { recursive: true });
  const shot = `${started}.png`;
  await writeFile(join(logDir, shot), png);
  await appendFile(join(logDir, 'log.jsonl'),
    JSON.stringify({ at: new Date(started).toISOString(), url: page.url(), action, label, reason, verdict, ms, shot }) + '\n');

  return verdict === 'allow' || verdict === 'approved';
}
