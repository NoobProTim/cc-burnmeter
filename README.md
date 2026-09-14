# CC-Burnmeter

A real-time token meter for Claude Code. Per API call it shows what was sent fresh, what was
re-sent from cache, what came back (thinking included), **what caused the turn** (you, a task
notification, a slash command, a cron wakeup, a compaction summary) and **what was injected**
without you typing it (hook output, skill bodies, reminders, tool results). Tokens, not quota
percentages: Claude Code already shows those.

**Scope: CLI sessions on this machine.** It reads the transcripts Claude Code writes locally. Web
and cloud sessions never touch local disk and are not seen. Nothing leaves the machine.

> Status: pre-release 0.2.0. Built and verified on macOS; Linux is written for (3-second polling
> fallback for new files); Windows is written for but not yet exercised in CI.

## Install

**As a Claude Code plugin (recommended)**

```
/plugin marketplace add NoobProTim/cc-burnmeter
/plugin install cc-burnmeter
/token-meter
```

The plugin's SessionStart hook starts the dashboard on port 4777 at your next session if nothing
answers there (a resident local process; it survives Claude Code exiting), and `/token-meter`
prints the URL with its access token. Requires Node 18+ on your PATH (the native Claude Code
installer does not add one; install Node or wait for the binary release).

- **Don't want auto-start?** `export CC_BURNMETER_AUTOSTART=0` and start it yourself with `npx cc-burnmeter serve`.
- **CI / headless:** SessionStart hooks also fire under `claude -p`; set `CC_BURNMETER_AUTOSTART=0` on runners.
- **Port taken?** The hook checks the server is really ours (`/api/hello`); if another program owns 4777 it says so once and stops. Set `CC_BURNMETER_PORT`.
- **See your own prompt text?** `CC_BURNMETER_SHOW_PROMPTS=1` (not on a shared machine).

**With npm**

```bash
npx cc-burnmeter serve 4777      # dashboard
npx cc-burnmeter url             # the URL with its token
npx cc-burnmeter doctor          # what it can see, what is wired
```

**Optional: status line** (backs up `settings.json`, merges, never replaces; `unwire` restores):

```bash
npx cc-burnmeter wire
```

## Two tiers

| Tier | Source | What it can see | Works with |
|---|---|---|---|
| **Transcripts** (default) | `~/.claude/projects/**/*.jsonl` | exact usage per completed API response, per session and subagent, turn source, injected content by hook/attachment, tool results by tool, compactions with before/after, ~1-8 s lag | every auth mode, including Bedrock / Vertex / Foundry |
| **Proxy** (opt-in) | a local pass-through on `127.0.0.1:4778` set as `ANTHROPIC_BASE_URL` | the same counts the instant a response starts, plus what is IN each request: system prompt, tool schemas by name (per MCP server), messages by role, live output estimate | claude.ai subscription and API-key logins only |

### Before you enable the proxy

Pointing `ANTHROPIC_BASE_URL` at any non-Anthropic host makes Claude Code itself change behaviour
(see https://code.claude.com/docs/en/feature-availability.md and
https://code.claude.com/docs/en/model-config.md, "LLM gateway"):

| What changes | What `wire --proxy` does about it |
|---|---|
| Remote Control and server-managed settings turn off | refuses unless `--force`, prints this table |
| Tool search defaults off: every MCP tool schema on every call (measured 542 KB vs 91 KB) | sets `ENABLE_TOOL_SEARCH=true` |
| Fine-grained tool streaming defaults off | sets it back on |
| 1M models (Sonnet 5, Fable, Opus 4.7+) are budgeted at 200K, so sessions compact in a loop | adds `[1m]` to your configured model (the documented alias, e.g. `fable[1m]`); haiku is left alone; nothing is invented if no model is set |

The proxy cannot detect the 200K budget from traffic (it is local to Claude Code); `doctor` checks
your settings instead. Undo everything with `npx cc-burnmeter unwire`.

## Dashboard sections

Live (every call with its source chip) · Inputs (one row per turn: what came in and what it cost to
send) · Who is spending (fresh tokens by source; cache reads excluded because they barely count
toward the five-hour quota) · Injected (hooks by name, attachments by type, tool results by tool) ·
Sessions (branch, CLI version, turns, thinking, compactions) · Session detail (context per call with
compaction markers, composition per call, what was sent when the proxy is on, turns with per-call
detail) · Events (compactions, queued messages, rate-limit hits).

Your own prompt text is never shown unless the server runs with `--show-prompts`.

## Run from source

```bash
node meter.cjs                 # terminal view
node meter.cjs --serve 4777    # dashboard
node meter.cjs --json --since 2h
npm test                       # meter, proxy, statusline, wire and hook self-tests (fake upstream only)
```

## Uninstall

In this order: `npx cc-burnmeter unwire` (restores settings, so no dangling status line),
`npx cc-burnmeter stop` (kills the dashboard it verified is ours), `/plugin uninstall cc-burnmeter`,
and delete `~/.claude/token-meter/` if you want the token and logs gone.

## Security

See [SECURITY.md](SECURITY.md): what is recorded, what is never recorded, loopback-only binding,
bearer token and Host guard.

## Files

`meter.cjs` engine, terminal view, dashboard server, JSON export, self-tests · `meter.html` the
dashboard · `statusline.cjs` status line command · `proxy.cjs` optional proxy · `wire.cjs`
wire / unwire / doctor · `cli.cjs` dispatcher · `skills/`, `hooks/`, `bin/`, `.claude-plugin/`
plugin packaging · `SPEC.md`, `PUBLISH-PLAN.md`, `ROLLBACK.md` design, plan, undo.

MIT © 2026 Timothy Joshua
