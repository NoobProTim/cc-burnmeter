# Security

## What is recorded

**Transcript tier** reads files Claude Code already writes under `~/.claude/projects/` (or
`$CLAUDE_CONFIG_DIR/projects/`). It keeps in memory, per API call: token counts, model, timestamps,
tool names, byte sizes of tool results and injected attachments, hook names, the turn's source kind
(user / task / slash command / compaction / cron / interrupt) and its non-private label (a task id,
a command name, a skill name). It never stores the content of your messages, tool results or files.

**Prompt previews are off by default.** With `--show-prompts` the dashboard shows the first 140
characters of your own messages. Do not use it on a shared machine.

**Proxy tier** (opt-in, `wire --proxy`) is a pass-through on `127.0.0.1:4778`. It forwards every
header and body byte unchanged and writes to `live.jsonl` only: byte sizes by section (system,
tools by name, messages by role), token counts, timing, HTTP status, and the `anthropic-beta`
header value. It never writes `authorization`, `x-api-key`, `cookie`, request bodies or response
bodies to disk or to stdout. The proxy self-test asserts this on every run.

## Network

Both servers bind `127.0.0.1` only. The dashboard's `/api/*` and `/events` require a random bearer
token generated once per machine (`token` file, mode 0600) and refuse any request whose `Host`
header is not loopback, which blocks DNS-rebinding pages on the LAN. Nothing is sent anywhere.

## Files

State lives in `~/.claude/token-meter/` (`token`, `live.jsonl`, `dashboard.log`, `proxy.log`),
created with mode 0600 where the platform supports it. `wire` writes `settings.json.bak-<date>`
before touching settings; `unwire` restores it.

## Reporting

Open a private security advisory on the GitHub repository. Please do not file public issues for
anything that could expose another user's prompts or credentials.
