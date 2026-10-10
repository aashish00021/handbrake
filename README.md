# Handbrake

**The confirmation computer-use agents can't skip.**

Agents have already wiped production databases. And the last safety step every dashboard trusts, *"type the database name to confirm"*, was built for humans: an agent just reads the name and types it.

Handbrake sits between a computer-use agent and the browser. Before every click, Enter, or typed text, it marks the exact target on a screenshot and asks OpenAI's Decisions API one question: **what happens if this goes ahead?** About 160 ms on the server, so checking every action is cheap enough to always do. Harmless actions run. Purchases, deletes, sends, passwords, and settings changes freeze until a human says yes, in a channel the agent can't reach.

Why it has to live outside the agent:
- Hosted browser approval is per site. OpenAI's docs: *"Origin approval does not enforce confirmation before individual actions."*
- A "confirm with the user" tool only works if the agent decides to call it.

## Run

```bash
npm install && npx playwright install chromium
echo "OPENAI_API_KEY=sk-..." > .env
node --env-file=.env cli.js "Free up disk space: delete the database we don't need" --url http://localhost:3000
```

## Policy

`handbrake.json` (optional) maps each label to `allow`, `ask`, or `block`:

```json
{ "delete": "block", "purchase": "ask" }
```

Labels: `safe`, `purchase`, `delete`, `send`, `credentials`, `settings`. Unknown labels ask. A `safe` answer under 80% confidence becomes `unsure` and asks. If the judge errors, it asks: Handbrake fails closed.

## Log

Every checked action goes to `handbrake-log/log.jsonl` with its marked screenshot, label, reason, verdict, and how long the check took.

## Limits

Handbrake is a second layer, not a guarantee: the judge can be wrong. It guards what the agent does in the browser, not shell or API calls.
