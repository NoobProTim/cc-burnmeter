#!/bin/sh
# SessionStart hook: make sure the dashboard is running. Idempotent and silent on
# success -- anything printed here lands in the model's context on every session.
# If something already answers on the port (this plugin's server, a launchd/systemd
# unit, or another instance), do nothing.
PORT="${CC_BURNMETER_PORT:-4777}"
if command -v curl >/dev/null 2>&1; then
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/" && exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "cc-burnmeter: node not found on PATH, dashboard not started (Node 18+ required; native-installer users see README)"
  exit 0
fi
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/token-meter}"
mkdir -p "$DATA" 2>/dev/null
nohup node "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/meter.cjs" --serve "$PORT" >>"$DATA/dashboard.log" 2>&1 &
exit 0
