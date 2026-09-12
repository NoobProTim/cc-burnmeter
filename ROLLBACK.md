# Token meter — what was wired on this Mac (2026-09-12) and how to undo it

> **STATUS 2026-09-12 ~21:05 UTC — proxy UNWIRED (quick unwire: `env.ANTHROPIC_BASE_URL` removed).** Behind the
> custom base URL, Claude Code budgeted 1M models (Sonnet 5, Fable) at 200K and turned tool search off. Sessions
> auto-compacted in a loop at 168k-333k. The launchd services still run idle, and the transcript tier + statusline still work.
> To re-wire, you need `ENABLE_TOOL_SEARCH=true` AND a `[1m]` model in every session.

## What is installed
- `~/Library/LaunchAgents/com.noobprotim.token-meter-proxy.plist` — runs `proxy.cjs` on 127.0.0.1:4778, KeepAlive (restarts within ~2s if it dies). Log: `~/.claude/token-meter/proxy.log`.
- `~/Library/LaunchAgents/com.noobprotim.token-meter-dashboard.plist` — runs `meter.cjs --serve 4777 --hours 24`. Open http://127.0.0.1:4777/. Log: `dashboard.log`.
- `~/.claude/settings.json` gained:
  - `env.ANTHROPIC_BASE_URL = http://127.0.0.1:4778` (every NEW Claude Code session routes through the proxy; sessions already open keep going direct)
  - `env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = 1` (restores a feature Claude Code turns off behind any custom base URL)
  - `env.ENABLE_TOOL_SEARCH = true` (added 2026-09-12 evening — behind a custom base URL tool search defaults OFF, so all 215 MCP/builtin tool schemas (~542 KB) were sent on every call; that pushed the post-compact floor to ~331k and made Sonnet sessions auto-compact in a loop. The proxy forwards headers/body intact, which tool search needs. Rollback: delete this line.)
  - `statusLine` → `node ~/.claude/token-meter/statusline.cjs`
- Backup of the pre-wire settings: `~/.claude/settings.json.bak-2026-09-12-token-meter`.

## Known cost while wired (verified against the docs, 2026-09-12)
Because the base URL is not api.anthropic.com, Claude Code turns OFF **Remote Control** and **server-managed
settings**, and tool search is off by default. The advisor keeps working (the proxy forwards requests intact).
Founder accepted this for the pilot.

## If Claude Code cannot connect ("connection refused", every request fails)
1. `launchctl list | grep token-meter` — the proxy row should show a PID.
2. `curl -sI http://127.0.0.1:4778/api/hello` — expect `HTTP/1.1 200`.
3. `tail -20 ~/.claude/token-meter/proxy.log`.
4. Restart: `launchctl kickstart -k gui/$(id -u)/com.noobprotim.token-meter-proxy`.

## Full rollback (one minute)
```bash
cp ~/.claude/settings.json.bak-2026-09-12-token-meter ~/.claude/settings.json
launchctl bootout gui/$(id -u)/com.noobprotim.token-meter-proxy
launchctl bootout gui/$(id -u)/com.noobprotim.token-meter-dashboard
rm ~/Library/LaunchAgents/com.noobprotim.token-meter-{proxy,dashboard}.plist
```
Open a new Claude Code session afterwards; it goes direct to api.anthropic.com again.

## Quick unwire without touching the services
Delete the `env` block and the `statusLine` key from `~/.claude/settings.json`. New sessions go direct; the
proxy just sits idle.
