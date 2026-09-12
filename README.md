# CC-Burnmeter

A real-time token consumption viewer for Claude Code. It answers, per API call: how much was sent
fresh, how much of your conversation was re-sent from cache, how much came back (thinking included),
and what it cost at list price. No quota percentages: Claude Code already shows those.

> **Status: private pre-release.** Built and verified on one macOS machine. The pre-mortem, polish
> list and publishing plan are in [PUBLISH-PLAN.md](PUBLISH-PLAN.md). Do not make this repo public
> before the scrub in that plan's §2 P0 #12 is done.

## Two tiers

| Tier | Source | What it can see | Works with |
|---|---|---|---|
| **Transcripts** (default) | `~/.claude/projects/**/*.jsonl` | exact usage per completed API response, per session and subagent, with ~1-8 s lag | every auth mode, including Bedrock/Vertex/Foundry |
| **Proxy** (opt-in) | a local pass-through on `127.0.0.1:4778` set as `ANTHROPIC_BASE_URL` | the same counts the instant the response starts, plus what is IN each request: system prompt, tool schemas by name, messages by role, and a live output estimate | claude.ai subscription and API-key logins only |

**Read before enabling the proxy:** with `ANTHROPIC_BASE_URL` pointed at any non-Anthropic host,
Claude Code itself turns off Remote Control and server-managed settings, and tool search and
fine-grained tool streaming default off (the installer restores streaming). **Also set
`ENABLE_TOOL_SEARCH=true`:** without it every MCP tool schema is sent on every call (measured 542 KB vs
91 KB), which roughly triples the post-compaction floor and makes sessions auto-compact in a loop. **And pick
a `[1m]` model** (e.g. `sonnet[1m]`): behind a custom base URL Claude Code budgets Sonnet 5 / Fable at 200K instead
of 1M, so sessions auto-compact at ~170k. See
https://code.claude.com/docs/en/feature-availability.md.

## Run

```bash
node meter.cjs                 # terminal view
node meter.cjs --serve 4777    # dashboard at http://127.0.0.1:4777/
node meter.cjs --json --since 2h
node meter.cjs --selftest
node proxy.cjs --selftest      # fake upstream only; never sends real traffic
```

Status line (add to `~/.claude/settings.json`):

```json
"statusLine": { "type": "command", "command": "node /absolute/path/to/statusline.cjs" }
```

## Security

The proxy forwards every header and body byte unchanged and records **only** sizes, counts and
tool names. It never writes an `authorization`, `x-api-key` or `cookie` value, nor any request or
response content, to disk or stdout. Both servers bind `127.0.0.1` only. State lives next to the
scripts and is gitignored.

## Files

- `meter.cjs` — engine, terminal view, dashboard server, JSON export, selftests
- `meter.html` — the dashboard
- `statusline.cjs` — Claude Code status line command
- `proxy.cjs` — the optional live proxy and its selftests
- `SPEC.md`, `BUILD-REPORT.md`, `PUBLISH-PLAN.md`, `ROLLBACK.md` — design, verification, plan, undo

MIT © 2026 Timothy Joshua
