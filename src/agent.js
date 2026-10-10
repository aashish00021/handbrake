import OpenAI from 'openai';
import { brake, needsCheck } from './brake.js';

const KEYS = {
  ENTER: 'Enter', RETURN: 'Enter', CTRL: 'Control', CONTROL: 'Control', CMD: 'Meta', META: 'Meta',
  ALT: 'Alt', OPTION: 'Alt', SHIFT: 'Shift', ESC: 'Escape', ESCAPE: 'Escape', SPACE: ' ', TAB: 'Tab',
  BACKSPACE: 'Backspace', DELETE: 'Delete', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown', ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight',
  HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown',
};
export const toPlaywrightKeys = (keys) => keys.map((k) => KEYS[k.toUpperCase()] ?? k).join('+');

const BUTTONS = { left: 'left', right: 'right', wheel: 'middle' };

async function run(page, a) {
  switch (a.type) {
    case 'click': return page.mouse.click(a.x, a.y, { button: BUTTONS[a.button] ?? 'left' });
    case 'double_click': return page.mouse.dblclick(a.x, a.y);
    case 'move': return page.mouse.move(a.x, a.y);
    case 'scroll': await page.mouse.move(a.x, a.y); return page.mouse.wheel(a.scroll_x, a.scroll_y);
    case 'type': return page.keyboard.type(a.text);
    case 'keypress': return page.keyboard.press(toPlaywrightKeys(a.keys));
    case 'drag': {
      const [first, ...rest] = a.path;
      await page.mouse.move(first.x, first.y);
      await page.mouse.down();
      for (const p of rest) await page.mouse.move(p.x, p.y);
      return page.mouse.up();
    }
    case 'wait': return page.waitForTimeout(1000);
    // 'screenshot' needs nothing: we always send one back
  }
}

const shot = async (page) => ({
  type: 'computer_screenshot',
  image_url: `data:image/png;base64,${(await page.screenshot()).toString('base64')}`,
  detail: 'original',
});

// Runs a computer-use agent on `page`; every risky action goes through the brake first.
export async function runAgent(page, task, { approve, policy, maxTurns = 30, onStep = () => {} } = {}) {
  const client = new OpenAI();
  const model = process.env.HANDBRAKE_AGENT_MODEL ?? 'gpt-6.1-sol';
  let response = await client.responses.create({ model, tools: [{ type: 'computer' }], input: task });

  for (let turn = 0; turn < maxTurns; turn++) {
    const call = response.output.find((o) => o.type === 'computer_call');
    if (!call) return response.output_text;

    // OpenAI's own checks (e.g. prompt injection on the page) go to the same human.
    const acknowledged = call.pending_safety_checks ?? [];
    for (const check of acknowledged) {
      const ok = await approve({ action: { type: 'safety_check' }, label: check.code ?? 'safety_check', reason: check.message ?? '' });
      if (!ok) return `Stopped: declined OpenAI safety check (${check.code}).`;
    }

    let note;
    for (const action of call.actions ?? (call.action ? [call.action] : [])) {
      onStep(action);
      if (needsCheck(action) && !(await brake(page, action, { approve, policy }))) {
        note = `Handbrake stopped your last action (${action.type}). A human did not allow it. Do not retry it; find a safe way or stop and explain.`;
        break; // drop the rest of the batch
      }
      await run(page, action);
    }

    const input = [{ type: 'computer_call_output', call_id: call.call_id, output: await shot(page), acknowledged_safety_checks: acknowledged }];
    if (note) input.push({ role: 'user', content: note });
    response = await client.responses.create({ model, tools: [{ type: 'computer' }], previous_response_id: response.id, input });
  }
  return `Stopped after ${maxTurns} turns.`;
}
