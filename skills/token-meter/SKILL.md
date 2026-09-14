---
name: token-meter
description: Open the CC-Burnmeter dashboard, explain a token figure, or wire/unwire the status line and the optional proxy. Use when the user asks about token usage, context size, what is being re-sent, which turns cost the most, or how to set up the meter.
---

# token-meter

CC-Burnmeter reads this machine's Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and
shows, per API call: fresh tokens, cache reads, output, thinking, what caused the turn, and what was
injected without the user typing it. Nothing leaves the machine. The dashboard needs its bearer
token in the URL, so always get the URL from the CLI rather than typing it.

## Commands (run with the Bash tool)

| Need | Command |
|---|---|
| Print the dashboard URL (with token) | `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" url` |
| Open it in the browser | `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" open` |
| Health check: config dir, settings, base URL, model, status line | `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" doctor` |
| Add the status line (backs up settings, merges, never replaces) | `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" wire` |
| Opt in to the proxy tier (prints the feature-loss table first) | `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" wire --proxy` |
| Undo everything wire did (byte-identical restore) | `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" unwire` |
| Dump normalized calls as JSONL | `node "${CLAUDE_PLUGIN_ROOT}/meter.cjs" --json --since 2h` |

The dashboard itself is started by this plugin's SessionStart hook if nothing answers on port 4777.
If `url` reports no token, run `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" serve 4777` once in the background.

## How to answer questions with it

- **"Why is my context so big?"** Open the session in the dashboard (Sessions → click a row). The
  context-per-call chart shows growth and every compaction with before/after sizes; the
  Injected table shows hook output and attachments by size; the tools table shows which tool
  results were fed back in.
- **"What is costing me tokens?"** Use *Who is spending*: fresh tokens grouped by what started each
  turn (the user, a task notification, a slash command, a compaction summary, a cron wakeup). Cache
  reads are excluded on purpose because they barely count toward the five-hour quota.
- **"Which turn was that?"** *Inputs* lists one row per turn with its source chip and what that
  input cost to send. The user's own text is shown only when the server runs with `--show-prompts`.

## Rules

- Never edit `settings.json` by hand to wire or unwire; `wire` and `unwire` keep a backup and the
  restore is byte-identical.
- Do not enable the proxy tier without telling the user what it turns off: with a custom base URL,
  Claude Code disables Remote Control and server-managed settings, and `wire --proxy` must set
  `ENABLE_TOOL_SEARCH=true` and a `[1m]` model alias or sessions compact in a loop.
- Prompt text is off by default. Do not suggest `--show-prompts` on a shared machine.
- Bedrock, Vertex and Foundry logins get the transcript tier only.
