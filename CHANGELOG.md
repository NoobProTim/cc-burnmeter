# Changelog

## 0.2.0 — 2026-09-14

- Dashboard rebuilt: dark HUD design, section rail, five stat tiles including "fresh tokens you caused".
- Input-source attribution: every turn and call is tagged with what started it (you, task
  notification, slash command, cron wakeup, compaction summary, local command output, interrupt).
  `isMeta` alone cannot separate these; classification is by content shape.
- New panels: Inputs (one row per turn with what the input cost to send), Who is spending (fresh
  tokens by source), Injected (hooks by name with size and run time, attachments by type, tool
  results by tool), Events (compactions with before/after/dropped, queued messages, rate-limit hits).
- Sessions show branch, CLI version, turn count, thinking tokens, compaction count; session detail
  shows permission mode, cwd, effort per call, and a per-session tools/injections table.
- Plugin packaging: `.claude-plugin/`, `/token-meter` skill, SessionStart hook that starts the
  dashboard if the port is free, `bin/token-meter` shim, `cli.cjs url|open`.
- `wire --proxy` preserves the configured model and adds `[1m]` only to 1M families (fable, sonnet,
  opus, mythos); it never invents a default and never suffixes haiku (rejected by the API).
- Removed the proxy's header-based "200K window" warning: the 200K budget behind a custom base URL is
  local to Claude Code and not visible in requests, so the check fired on every healthy 1M call.
  `doctor` checks settings instead.
- Privacy defaults, bearer token + Host guard, `CLAUDE_CONFIG_DIR`, bounded parse concurrency,
  proxy warnings for tool-search-off (from the p0-polish series).

## 0.1.0 — 2026-09-12

- Transcript tier (engine, terminal view, dashboard, status line) and opt-in proxy tier.
