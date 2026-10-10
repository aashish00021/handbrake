// End-to-end, no API key needed: the real MCP server and browser on the demo console,
// with a stand-in judge (an OpenAI-compatible endpoint that says "delete" for Delete buttons).
// Run: npm run e2e   (needs: npx playwright install chromium)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const consoleUrl = pathToFileURL(join(here, 'demo/console.html')).href;

const judge = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const lands = JSON.parse(body).messages[0].content[0].text.match(/It lands on: (.*)/)[1];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: /^click on button "Delete/.test(lands) ? 'delete' : 'safe' } }] }));
  });
});
await new Promise((r) => judge.listen(0, '127.0.0.1', r));
const env = {
  ...process.env,
  HANDBRAKE_JUDGE: 'chat',
  HANDBRAKE_JUDGE_BASE_URL: `http://127.0.0.1:${judge.address().port}`,
  HANDBRAKE_JUDGE_KEY: 'test',
  HANDBRAKE_HEADLESS: '1',
};

async function connect({ answers } = {}) {
  const client = new Client({ name: 'e2e', version: '1' }, answers ? { capabilities: { elicitation: { form: {} } } } : {});
  const prompts = [];
  if (answers) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return { action: 'accept', content: answers.shift() ? { allow: true } : {} }; // unticked box = {}
    });
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, 'mcp.js')], env }));
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.find((c) => c.type === 'text').text;
  const at = (text, label) => text.match(new RegExp(`${label} at \\((\\d+),(\\d+)\\)`)).slice(1).map(Number);
  return { client, prompts, call, at };
}

test('delete flow: asks only at the two Deletes; Continue without ticking blocks', async () => {
  const { client, prompts, call, at } = await connect({ answers: [false, true, false] });
  try {
    const page = await call('open', { url: consoleUrl });
    const [x, y] = at(page, 'button "Delete" in row "prod-main[^"]*"');

    assert.match(await call('click', { x, y }), /^BLOCKED/, 'unticked Continue must block');
    const dialog = await call('click', { x, y }); // ticked: dialog opens
    assert.match(dialog, /Delete database prod-main\?/);

    const [fx, fy] = at(dialog, 'input "[^"]*"');
    assert.doesNotMatch(await call('click', { x: fx, y: fy }), /^BLOCKED/); // focusing a field: silent
    const typed = await call('type', { text: 'prod-main' }); // typing: silent
    assert.doesNotMatch(typed, /^BLOCKED/);

    const [dx, dy] = at(typed, 'button "Delete database"');
    assert.match(await call('click', { x: dx, y: dy }), /^BLOCKED/);
    assert.match(await call('look'), /prod-main\s+2\.4 GB/, 'prod-main must survive');

    assert.equal(prompts.length, 3, 'one prompt per Delete click, none for focus or typing');
    assert.match(prompts[0], /DELETE[\s\S]*"Delete" in "prod-main 2\.4 GB/);
  } finally {
    await client.close();
  }
});

test('a client that cannot show prompts gets blocked, never allowed', async () => {
  const { client, call, at } = await connect();
  try {
    const page = await call('open', { url: consoleUrl });
    const [x, y] = at(page, 'button "Delete" in row "prod-main[^"]*"');
    assert.match(await call('click', { x, y }), /^BLOCKED/);
  } finally {
    await client.close();
  }
});

test.after(() => judge.close());
