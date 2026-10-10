#!/usr/bin/env node
// Handbrake as an MCP server: a browser for Codex, Claude Code or any MCP client,
// where every risky action is judged first and approved in the client's own prompt.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright';
import { z } from 'zod';
import { toPlaywrightKeys } from './src/agent.js';
import { brake, DEFAULT_POLICY, needsCheck } from './src/brake.js';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(here, '.env')); } catch {} // OPENAI_API_KEY, so client configs stay key-free
const policy = { ...DEFAULT_POLICY, ...JSON.parse(await readFile(process.env.HANDBRAKE_POLICY ?? join(here, 'handbrake.json'), 'utf8').catch(() => '{}')) };
const logDir = join(here, 'handbrake-log');

const server = new McpServer({ name: 'handbrake', version: '0.1.0' });

let page;
async function getPage() {
  if (!page || page.isClosed()) {
    const browser = await chromium.launch({ headless: process.env.HANDBRAKE_HEADLESS === '1' });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  }
  return page;
}

// The human answers in the client's own prompt. No answer, a "no", or a client
// that can't ask: all block.
async function approve({ label, reason, target }) {
  try {
    const res = await server.server.elicitInput({
      message: `HANDBRAKE · ${label.toUpperCase()} (${reason})\nThe agent wants to: ${target}\nAllow it?`,
      requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: 'Allow this action', default: false } } }, // unticked = no
    });
    return res.action === 'accept' && res.content?.allow === true;
  } catch {
    return false;
  }
}

// Visible interactive elements with their centre points, so the agent can click by number.
async function elements(p) {
  return p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a, button, input, select, textarea, [role=button], [onclick]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const row = el.closest('tr, li')?.innerText.replace(/\s+/g, ' ').trim().slice(0, 60);
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      out.push({ tag: el.tagName.toLowerCase(), text, row, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return out;
  });
}

async function look() {
  const p = await getPage();
  const list = (await elements(p)).map((e, i) => `[${i}] ${e.tag} "${e.text}"${e.row && e.row !== e.text ? ` in row "${e.row}"` : ''} at (${e.x},${e.y})`);
  return {
    content: [
      { type: 'text', text: `${p.url()}\n${(await p.innerText('body')).slice(0, 2000)}\n\nElements:\n${list.join('\n')}` },
      { type: 'image', data: (await p.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'), mimeType: 'image/jpeg' },
    ],
  };
}

// Every acting tool goes through here.
async function act(action, run) {
  const p = await getPage();
  if (needsCheck(action) && !(await brake(p, action, { approve, policy, logDir }))) {
    return { content: [{ type: 'text', text: `BLOCKED by Handbrake: a human did not allow this ${action.type}. Do not retry it or work around it. Stop and tell the user what you were trying to do.` }] };
  }
  await run(p);
  await p.waitForTimeout(300);
  return look();
}

server.registerTool('open', {
  description: 'Open a URL in the Handbrake browser. Returns the page text, numbered clickable elements with coordinates, and a screenshot.',
  inputSchema: { url: z.string() },
}, async ({ url }) => { await (await getPage()).goto(url); return look(); });

server.registerTool('look', { description: 'Show the current page: text, numbered clickable elements with coordinates, screenshot.' }, look);

server.registerTool('click', {
  description: 'Click at page coordinates (use the coordinates from look). Risky clicks need a human OK.',
  inputSchema: { x: z.number(), y: z.number() },
}, ({ x, y }) => act({ type: 'click', button: 'left', x, y }, (p) => p.mouse.click(x, y)));

server.registerTool('type', {
  description: 'Type text into the focused field (click the field first). Risky input needs a human OK.',
  inputSchema: { text: z.string() },
}, ({ text }) => act({ type: 'type', text }, (p) => p.keyboard.type(text)));

server.registerTool('press', {
  description: 'Press keys, e.g. ["ENTER"] or ["CTRL","A"]. Enter needs a human OK when it submits something risky.',
  inputSchema: { keys: z.array(z.string()) },
}, ({ keys }) => act({ type: 'keypress', keys }, (p) => p.keyboard.press(toPlaywrightKeys(keys))));

server.registerTool('scroll', {
  description: 'Scroll the page by dy pixels (positive = down).',
  inputSchema: { dy: z.number() },
}, ({ dy }) => act({ type: 'scroll', x: 640, y: 400, scroll_x: 0, scroll_y: dy }, (p) => p.mouse.wheel(0, dy)));

await server.connect(new StdioServerTransport());
