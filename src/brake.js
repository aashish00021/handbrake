import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// What a gated action can do, and how the judge tells them apart.
export const CHOICES = {
  safe: 'None of the others: reading, navigating, searching, opening menus, filling harmless fields, cancelling.',
  purchase: 'Spends money or places an order.',
  delete: 'Permanently removes data, a database, a resource or an account, or confirms such a removal.',
  send: 'Sends, posts or publishes something to other people.',
  credentials: 'Enters or submits a password, card number, API key, token or other secret.',
  settings: 'Changes account, security, billing or permission settings.',
};

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
  'A browser agent is about to act on this page. A red ring marks where it will click; ' +
  'a red outline marks the field it will type into or submit. What happens if the action goes ahead?';

// Below this, a "safe" answer still goes to a human.
const SAFE_CONFIDENCE = 0.8;

// What the action lands on, in words: the element's text and the row or dialog it sits in.
export async function describeTarget(page, action) {
  return page.evaluate(({ x, y, type, text }) => {
    const squash = (t, n) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const hit = x != null ? document.elementFromPoint(x, y) : document.activeElement;
    if (!hit || hit === document.body) return type === 'type' ? `typing "${squash(text, 40)}"` : 'nothing in particular';
    const el = hit.closest('a, button, input, select, textarea, [role=button], [onclick]') ?? hit;
    const name = squash(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label'), 60);
    const where = squash(el.closest('tr, li, form, dialog, [role=dialog], .modal, .card')?.innerText, 120);
    const what = type === 'type' ? `typing "${squash(text, 40)}" into ${el.tagName.toLowerCase()} "${name}"` : `${type} on ${el.tagName.toLowerCase()} "${name}"`;
    return where && where !== name ? `${what} in "${where}"` : what;
  }, { x: action.x, y: action.y, type: action.type, text: action.text });
}

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
  const img = await page.screenshot({ type: 'jpeg', quality: 80 }); // smaller upload, same verdicts
  await page.evaluate(() => document.getElementById('__handbrake_marker')?.remove());
  return img;
}

// Fails closed: any error becomes an "unsure", which asks a human.
export async function judge(png, action, target = '') {
  try {
    const res = await fetch('https://api.openai.com/v1/decisions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: `Pending action: ${JSON.stringify(action)}\nIt lands on: ${target}` },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${png.toString('base64')}` },
          ],
        }],
        questions: [{
          type: 'choice',
          name: 'outcome',
          instructions: QUESTION,
          choices: Object.entries(CHOICES).map(([value, description]) => ({ value, description })),
        }],
      }),
    });
    if (!res.ok) return { label: 'unsure', reason: `judge error ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const answer = (await res.json()).answers?.[0];
    if (answer?.type !== 'choice') return { label: 'unsure', reason: `judge gave no choice (${answer?.type})` };
    const p = answer.probabilities?.find((x) => x.value === answer.choice)?.probability ?? answer.confidence ?? 0;
    const label = answer.choice === 'safe' && p < SAFE_CONFIDENCE ? 'unsure' : answer.choice;
    return { label, reason: `${Math.round(p * 100)}% ${answer.choice}` };
  } catch (err) {
    return { label: 'unsure', reason: `judge unreachable: ${err.message}` };
  }
}

// Returns true if the action may run. Every checked action is logged with its screenshot.
export async function brake(page, action, { policy = DEFAULT_POLICY, approve, logDir = 'handbrake-log' } = {}) {
  const started = Date.now();
  const target = await describeTarget(page, action);
  const png = await markedScreenshot(page, action);
  const { label, reason } = await judge(png, action, target);
  const ms = Date.now() - started;
  let verdict = verdictFor(label, policy);
  let waitedMs = 0; // how long the human took: ~0 means nobody actually answered
  if (verdict === 'ask') {
    const asked = Date.now();
    verdict = (await approve({ action, label, reason, target, png })) ? 'approved' : 'denied';
    waitedMs = Date.now() - asked;
  }

  await mkdir(logDir, { recursive: true });
  const shot = `${started}.jpg`;
  await writeFile(join(logDir, shot), png);
  await appendFile(join(logDir, 'log.jsonl'),
    JSON.stringify({ at: new Date(started).toISOString(), url: page.url(), action, target, label, reason, verdict, ms, waitedMs, shot }) + '\n');

  return verdict === 'allow' || verdict === 'approved';
}
