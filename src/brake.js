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
    const name = squash(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.previousElementSibling?.innerText, 60) || 'unnamed';
    let where = squash(el.closest('tr, li, form, dialog, [role=dialog], .modal, .card')?.innerText, 400);
    if (name && where.endsWith(name)) where = where.slice(0, -name.length).trim(); // the button's own label adds nothing
    where = where.slice(0, 120);
    const what = type === 'type' ? `typing "${squash(text, 40)}" into ${el.tagName.toLowerCase()} "${name}"` : `${type} on ${el.tagName.toLowerCase()} "${name}"`;
    return where && where !== name ? `${what} in "${where}"` : what;
  }, { x: action.x, y: action.y, type: action.type, text: action.text });
}

// A click that only puts the cursor in a text field changes nothing; what gets typed is checked later.
export async function focusesTextField(page, action) {
  if (action.type !== 'click' || action.x == null) return false;
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number', 'password', ''].includes(el.getAttribute('type') ?? '');
  }, { x: action.x, y: action.y });
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

// OpenAI's Decisions API: fast, and gives a probability per choice.
async function askDecisions(img, action, target) {
  const res = await fetch('https://api.openai.com/v1/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6-luna',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `Pending action: ${JSON.stringify(action)}\nIt lands on: ${target}` },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${img.toString('base64')}` },
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
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 404 ? ' (no Decisions API access? set HANDBRAKE_JUDGE=chat)' : '';
    return { label: 'unsure', reason: `judge error ${res.status}${hint}: ${(await res.text()).slice(0, 200)}` };
  }
  const answer = (await res.json()).answers?.[0];
  if (answer?.type !== 'choice') return { label: 'unsure', reason: `judge gave no choice (${answer?.type})` };
  const p = answer.probabilities?.find((x) => x.value === answer.choice)?.probability ?? answer.confidence ?? 0;
  const shaky = answer.choice === 'safe' && p < SAFE_CONFIDENCE && action.type !== 'type'; // typing commits nothing by itself
  return { label: shaky ? 'unsure' : answer.choice, reason: `${Math.round(p * 100)}% ${answer.choice}` };
}

// Any OpenAI-compatible chat endpoint with a vision model: OpenAI, OpenRouter, Azure, a local Ollama...
// ponytail: one-word answer, no probabilities, so a shaky "safe" can't be caught here
async function askChat(img, action, target) {
  const base = process.env.HANDBRAKE_JUDGE_BASE_URL ?? 'https://api.openai.com/v1';
  const model = process.env.HANDBRAKE_JUDGE_MODEL ?? 'gpt-6.1-sol';
  const choices = Object.entries(CHOICES).map(([value, description]) => `${value}: ${description}`).join('\n');
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.HANDBRAKE_JUDGE_KEY ?? process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${QUESTION}\nPending action: ${JSON.stringify(action)}\nIt lands on: ${target}\n\n${choices}\n\nAnswer with exactly one word: ${Object.keys(CHOICES).join(', ')}.` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.toString('base64')}` } },
        ],
      }],
    }),
  });
  if (!res.ok) return { label: 'unsure', reason: `judge error ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const said = ((await res.json()).choices?.[0]?.message?.content ?? '').toLowerCase();
  const word = Object.keys(CHOICES).find((c) => new RegExp(`\\b${c}\\b`).test(said));
  return word ? { label: word, reason: `${word} (${model})` } : { label: 'unsure', reason: `judge said "${said.slice(0, 60)}"` };
}

// Fails closed: any error becomes an "unsure", which asks a human.
export async function judge(img, action, target = '') {
  try {
    return await (process.env.HANDBRAKE_JUDGE === 'chat' ? askChat : askDecisions)(img, action, target);
  } catch (err) {
    return { label: 'unsure', reason: `judge unreachable: ${err.message}` };
  }
}

// Returns true if the action may run. Every checked action is logged with its screenshot.
export async function brake(page, action, { policy = DEFAULT_POLICY, approve, logDir = 'handbrake-log' } = {}) {
  if (await focusesTextField(page, action)) return true;
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
