# Handbrake

**The confirmation computer-use agents can't skip.**

Agents have already wiped production databases. And the last safety step every dashboard trusts, *"type the database name to confirm"*, was built for humans: an agent just reads the name and types it.

Handbrake sits between a computer-use agent and the browser. Before every click, Enter, or typed text, it marks the exact target on a screenshot and asks OpenAI's Decisions API one question: **what happens if this goes ahead?** About 160 ms on the server, so checking every action is cheap enough to always do. Harmless actions run. Purchases, deletes, sends, passwords, and settings changes freeze until a human says yes, in a channel the agent can't reach.

Open source (MIT), self-hosted, bring your own key: it runs on your machine, and the only thing that leaves it is the screenshot sent to the judge you choose. Point the judge at a local model and nothing leaves at all.

Why it has to live outside the agent:
- Hosted browser approval is per site. OpenAI's docs: *"Origin approval does not enforce confirmation before individual actions."*
- A "confirm with the user" tool only works if the agent decides to call it.

## Install

```bash
git clone https://github.com/aashish00021/handbrake && cd handbrake
npm install && npx playwright install chromium
cp .env.example .env   # add your key
```

Needs Node 20+.

## Pick a judge

| `HANDBRAKE_JUDGE` | What it calls | Speed per check | Needs |
|---|---|---|---|
| `decisions` (default) | OpenAI Decisions API (`gpt-6-luna`) | ~0.3–0.6 s | an OpenAI key with Decisions access |
| `chat` | any OpenAI-compatible `/chat/completions` with a vision model | ~2 s | any key: OpenAI, OpenRouter, Azure, or none for a local Ollama |

```bash
# OpenRouter, any vision model it serves
HANDBRAKE_JUDGE=chat
HANDBRAKE_JUDGE_BASE_URL=https://openrouter.ai/api/v1
HANDBRAKE_JUDGE_KEY=sk-or-...
HANDBRAKE_JUDGE_MODEL=<a vision model>

# Fully local with Ollama: screenshots never leave your machine
HANDBRAKE_JUDGE=chat
HANDBRAKE_JUDGE_BASE_URL=http://localhost:11434/v1
HANDBRAKE_JUDGE_KEY=ollama
HANDBRAKE_JUDGE_MODEL=<a local vision model>
```

Only the Decisions judge returns probabilities, so only it can turn a shaky "safe" into a question. Measured on the same five test screens (delete, cancel, place order, continue shopping, password): Decisions 5/5, chat with `gpt-6.1-sol` 5/5. Other models are untested; check yours before trusting it.

## Use it from Codex or Claude Code

Handbrake is an MCP server: a browser whose risky actions ask you first, in the app's own approval prompt. No answer, a "no", or a client that can't ask all block. `mcp.js` reads `.env` from its own folder, so client configs stay key-free.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.handbrake]
command = "node"
args = ["/absolute/path/to/handbrake/mcp.js"]
default_tools_approval_mode = "approve"  # Handbrake asks for the risky ones itself
```

Codex prefers its built-in browser, so name the tools in the prompt (`mcp__handbrake__open`, ...) or turn the built-in browser plugin off for the session.

**Claude Code:** open this folder (`.mcp.json` is included), or `claude mcp add handbrake -- node /absolute/path/to/handbrake/mcp.js`.

Then ask the agent to use the handbrake browser: *"Use the handbrake tools to open http://... and ..."*. Tools: `open`, `look`, `click`, `type`, `press`, `scroll`. Turn off other browser tools if you want Handbrake to be the only way in.

## Run its own agent

```bash
npm run demo   # serves demo/console.html at http://127.0.0.1:8787/console.html
node --env-file=.env cli.js "Free up disk space: delete the database we don't need" --url http://localhost:3000
```

## Policy

`handbrake.json` (optional) maps each label to `allow`, `ask`, or `block`:

```json
{ "delete": "block", "purchase": "ask" }
```

Labels: `safe`, `purchase`, `delete`, `send`, `credentials`, `settings`. Unknown labels ask. A `safe` answer under 80% confidence becomes `unsure` and asks. If the judge errors, it asks: Handbrake fails closed.

## Log

Every checked action goes to `handbrake-log/log.jsonl` with its marked screenshot, target, label, reason, verdict, how long the check took, and how long the human took to answer (near zero means no person answered).

## Limits

Handbrake is a second layer, not a guarantee: the judge can be wrong. It guards what the agent does in the Handbrake browser, not shell or API calls, and not other browser tools you leave switched on.
