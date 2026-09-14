# Token Meter — Pre-mortem, polish list, and publishing plan

Written 2026-09-12 by the factory lead (Fable 5.1) at the founder's request. Inputs: a line-cited
audit of `meter.cjs` / `proxy.cjs` / `statusline.cjs` / `meter.html`, a survey of how the plugins on
this machine package hooks and background processes, and the official Claude Code docs on install,
auth, gateways, status line, settings and plugins. Doc URLs are cited inline.

Current state of the build: Tier 1 (transcripts → dashboard + terminal + status line) and Tier 2
(local proxy) are built, selftests 10/10 and 9/9, reconcile identical, all review defects A–G fixed.
The proxy has passed ONE real-traffic test on this machine (OAuth login, counts equal the transcript).
Nothing is wired into settings yet. Nothing exists on GitHub.

---

## 0. The one-paragraph verdict

The transcript tier is safe to publish after a modest cleanup. The proxy tier is the feature nobody
else ships, but it is also the only part that can break Claude Code itself, and pointing
`ANTHROPIC_BASE_URL` at any non-Anthropic host makes Claude Code turn off Remote Control,
server-managed settings, tool search, and fine-grained tool streaming
(https://code.claude.com/docs/en/feature-availability.md, "Note"). So: **ship the transcript tier
as the default install, make the proxy an explicit opt-in with a health-checked wiring step and a
one-command unwire, and publish as a Claude Code plugin backed by a GitHub repo, with an npm
package as a second channel and single-file binaries later for users who have no Node.**

---

## 1. Pre-mortem — how it fails, by the kind of user who installs it

Format: who they are → what they do → what breaks → evidence (file:line or doc).

### 1.1 Beginner on a Pro plan, native installer, macOS, no Node
- They paste the status line command into settings. `node` is not on their PATH: the native
  installer bundles its own runtime and does not put `node` on PATH
  (https://code.claude.com/docs/en/platforms.md). The status line shows an error every turn.
- They run `node meter.cjs`: "command not found". They give up.
- **Fix:** an install step that checks for Node ≥ 18 and says exactly what to install; later, a
  single-file binary per platform (§3.3).

### 1.2 Intermediate user, npm install, Linux
- `fs.watch(..., {recursive:true})` throws or no-ops on Linux; the catch is silent
  (meter.cjs:843, 850-852). They get a 10-second-lag dashboard and think it is broken.
- The doc-suggested `node ~/.claude/token-meter/statusline.cjs` works, but there is no launchd on
  Linux, so nothing keeps the proxy alive across reboots.
- **Fix:** detect the platform and say "polling mode, 3s"; ship a systemd user unit; never rely on
  a silent catch.

### 1.3 Native Windows user (PowerShell, not WSL)
- `~` in the settings command string is not expanded (statusline.cjs:11 comment). Paths with
  backslashes; no launchd; `open` does not exist.
- **Fix:** write absolute paths into settings at wire time; a Task Scheduler entry or the plugin
  monitor (§3.2) instead of launchd; test in a Windows CI job.

### 1.4 Power user with an existing status line, env settings, several sessions, subagents, Remote Control
- Only one `statusLine` command is active; a naive install replaces theirs
  (https://code.claude.com/docs/en/statusline.md). Same for an existing `env` block.
- They use Remote Control (this machine has `remoteControlAtStartup` set). Wiring the proxy turns
  Remote Control OFF, and the docs say Claude Code does that whatever the gateway forwards.
- They run 5,000+ transcripts (this machine: 5,270 files, 4.4 GB). Startup opens every file at
  once (meter.cjs:797) → `EMFILE` on a 256 descriptor limit. Sessions are never evicted from memory
  (meter.cjs:444-476), so a days-long server grows without bound.
- **Fix:** merge, never replace; refuse to wire the proxy when Remote Control is on unless
  `--force`, and print the feature-loss table; cap parse concurrency; evict sessions outside the
  window; rotate `live.jsonl` while running (proxy.cjs:134-146 rotates only at startup).

### 1.5 Enterprise developer on an API key behind a corporate gateway
- They already have `ANTHROPIC_BASE_URL=https://gateway.corp`. Our wiring overwrites it and the
  proxy's upstream defaults to `api.anthropic.com` (proxy.cjs:31) → their auth breaks silently.
- Their outbound HTTPS needs `HTTPS_PROXY`; Node's core `https` ignores it (proxy.cjs:267-269) →
  the proxy cannot reach the internet while Claude Code could.
- Their gateway needs mTLS (`CLAUDE_CODE_CLIENT_CERT/KEY`); the proxy has no client-cert path.
- Managed settings (highest precedence) can pin `env`; our user-level env is then ignored and the
  proxy sees no traffic, with no message.
- **Fix:** capture the pre-existing base URL as the upstream at wire time; honor
  `HTTPS_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, and the three mTLS vars; `--doctor` reports the
  effective settings source and whether managed settings win.

### 1.6 Bedrock / Vertex / Foundry user
- `ANTHROPIC_BASE_URL` does not apply to them at all; they use `ANTHROPIC_BEDROCK_BASE_URL` etc.
  and provider auth (https://code.claude.com/docs/en/authentication.md). The proxy tier is
  impossible by design (proxy.cjs architecture, audit #17).
- Their model ids are ARNs / resource paths; the price table matches substrings of first-party
  names only (meter.cjs:44-58) → every call shows unpriced.
- **Fix:** transcript tier only, stated plainly in the README; normalize provider ids to the base
  model name; honor Claude Code's own `modelPricing` setting
  (https://code.claude.com/docs/en/settings-reference.md).

### 1.7 Team / Enterprise on server-managed settings
- Pointing the base URL anywhere turns server-managed settings off. Their admin's policy stops
  applying the moment they wire the proxy. That is a compliance problem, not a bug.
- **Fix:** the wiring step detects a Team/Enterprise login (org id in `~/.claude.json`) and refuses
  the proxy tier without `--force`; README says so in the first screen.

### 1.8 Privacy-minded user, shared machine, devcontainer, SSH tunnel
- The dashboard serves the first 140 characters of every user prompt (meter.cjs:302-311, 574;
  meter.html:574) over an unauthenticated HTTP API with no Origin check (meter.cjs:996-1039).
  In a container with forwarded ports or via DNS rebinding, another party reads it.
- `live.jsonl` holds per-request byte breakdowns by tool name. No body content or secrets (verified
  by the proxy selftest and a 0-hit secret scan), but the file is world-readable by default.
- **Fix:** prompt preview OFF by default; a random bearer token for `/api/*` and `/events`
  (0600 file, embedded in the launch URL); reject requests whose Host is not loopback; write
  state files 0600.

### 1.9 Headless / CI user (`claude -p`, GitHub Actions)
- No status line. Transcripts may be off (`--no-session-persistence`,
  `CLAUDE_CODE_SKIP_PROMPT_HISTORY`). The meter shows nothing and says nothing (audit #11).
- **Fix:** `--doctor` prints "session persistence off, nothing to read"; the proxy tier still works
  in CI and is the only source there.

### 1.10 Desktop app, VS Code / JetBrains, claude.ai/code web users
- Each surface keeps its own session history (https://code.claude.com/docs/en/sessions.md). Web and
  cloud sessions never touch the local disk. The Desktop app's gateway routing is configured in the
  app, not from `settings.json`.
- **Fix:** README scope line: "CLI sessions on this machine". Do not claim more.

### 1.11 Old or very new Claude Code versions
- `prompt_cache` in the status line JSON needs ≥ 2.1.251; `rate_limits` is Pro/Max only and absent
  until the first response. Transcript field names have changed before and will again; subagent
  directory layout is assumed (meter.cjs:349-373).
- **Fix:** every reader tolerates absent fields; `--doctor` reports the CLI version; a fixture
  corpus of transcripts from several versions runs in CI.

### 1.12 Everyone: the proxy dies
- Claude Code fails fast with a connection error on the first request when the gateway is
  unreachable (https://code.claude.com/docs/en/llm-gateway-protocol.md). No `error` handler on
  `listen` (meter.cjs:1044, proxy.cjs:371), no `uncaughtException` handler (audit #27), a bad URL
  throws inside the request callback (proxy.cjs:266). A crash = Claude Code stops working until the
  user figures out why.
- **Fix:** supervisor with restart; the wiring step probes `HEAD /api/hello` through the proxy
  BEFORE writing settings; `token-meter unwire` restores the backup in one command; the proxy logs
  and keeps serving on any per-request exception.

### 1.13 The tool's own credibility
- `stripSlugPrefix` hardcodes the developer's own home-directory slug (meter.cjs:78-81). Every
  other user sees full slugs and an obvious "built for one machine" smell.
- Statusline's first-seen session starts counting at the current offset (statusline.cjs:84-96),
  so "session: X in" understates until restart.
- Errors collapse to `token-meter: n/a` with no log (statusline.cjs:163-198).
- **Fix:** derive the prefix from `os.homedir()`; label the counter "since HH:MM" until backfilled,
  or backfill the last N MB; write a rotating `meter.log`.

---

## 2. Polish list (ordered; each item has the check that proves it)

### P0 — must land before anything is public
| # | Change | Proof |
|---|---|---|
| 1 | **Two-tier install.** Default = transcripts only. Proxy = `token-meter wire --proxy`, prints the feature-loss table, refuses when Remote Control is on or the login is Team/Enterprise unless `--force`. | `wire --proxy` on this machine refuses (remoteControlAtStartup set); `--force` proceeds. |
| 2 | **Health-checked wiring + unwire.** `wire` backs up `settings.json`, merges (never replaces) `env` and `statusLine`, probes `HEAD /api/hello` through the proxy first, and `unwire` restores. | Kill the proxy, run `wire --proxy` → refuses; run `unwire` → settings byte-identical to backup. |
| 3 | **Supervisor.** launchd KeepAlive (macOS), systemd user unit (Linux), scheduled task (Windows); plus the plugin `monitors/` entry as a per-session fallback that starts the proxy only if the port is free. | `kill -9` the proxy → back within 5s on each OS. |
| 4 | **Never crash.** `server.on('error')` with a plain message for EADDRINUSE; `uncaughtException`/`unhandledRejection` → log and continue; try/catch around URL parse. | Start two instances → second prints "port 4778 in use by pid N" and exits 1; malformed request → 400, process alive. |
| 5 | **Chain the upstream.** Upstream = the pre-existing `ANTHROPIC_BASE_URL` captured at wire time, stored in `config.json`, else api.anthropic.com. Honor `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CLIENT_CERT/KEY/PASSPHRASE`. | Selftest with a fake gateway + fake forward proxy; mTLS selftest with a self-signed pair. |
| 6 | **Privacy defaults.** Prompt preview off unless `--show-prompts`; bearer token on `/api/*` and `/events`; loopback Host check; state files 0600. | `curl` without the token → 401; with a spoofed Host → 403. |
| 7 | **Locate like Claude Code does.** `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, Windows paths, homedir-derived slug prefix. | Fixture run with `CLAUDE_CONFIG_DIR` set on macOS, Linux, Windows CI. |
| 8 | **Pricing that degrades honestly.** Normalize Bedrock/Vertex ids; read `modelPricing` from settings; user-editable `pricing.json`; show "unpriced (N calls)" not `?`; `--check-pricing` lists unseen ids. | Feed an ARN id → priced as sonnet-5; feed `future-model` → listed as unpriced. |
| 9 | **Scale.** Parse concurrency cap (32); evict sessions outside `--hours`; rotate `live.jsonl` while running; Linux watch fallback with a printed notice. | Start against 5,270 files with `ulimit -n 256` → no EMFILE; 24h soak, RSS flat. |
| 10 | **`--doctor`.** Prints: CLI version, install type, node version, config dir, projects dir + file count, persistence on/off, auth mode, existing base URL, managed-settings override, statusLine present, proxy reachable, watch mode. | Run on this machine and on a clean VM; every line either green or a sentence saying what to do. |
| 11 | **Statusline correctness.** Chain an existing status line (`--chain "<old command>"`), bounded backfill, "since HH:MM" label, rotating log. | Existing command still renders; totals equal the dashboard after backfill. |
| 12 | **Scrub.** Remove the developer's home-directory prefix, session ids and project names from code, BUILD-REPORT and screenshots; regenerate screenshots from a fixture. | grep the tracked tree for the real username/session-id/project-name literals -> 0 hits. |

### P1 — before calling it 1.0
- Fixture corpus of transcripts across CLI versions; CI matrix macOS/Linux/Windows × Node 18/20/22.
- Dashboard: keyboard nav, reduced-motion, `color-mix` fallback for older engines.
- README: scope line ("CLI sessions on this machine"), the feature-loss table, the Bedrock/Vertex
  "transcript tier only" note, uninstall, and a SECURITY.md stating what is and is not recorded.
- Homebrew tap and WinGet manifest.

---

## 3. The usage audit — the founder's question

**Feasible, and the strongest differentiator.** Two things already exist and must be acknowledged
rather than duplicated: `/insights` (built in, narrative, no token attribution) and the status
line's `prompt_cache` object (≥ 2.1.251: `misses`, `miss_causes`, `hit_ratio`, per live session,
main conversation only). What does NOT exist is a quantitative, historical, cross-session,
subagent-inclusive audit with a price on every recommendation.

### 3.1 What the data already supports (transcript tier)
| Signal | Source in the transcript | Recommendation it yields |
|---|---|---|
| Cold-start size per session | first call's `cache_creation_input_tokens` | "Your sessions start at 197k tokens; the median Claude Code user starts under 30k." |
| Hook and plugin injection | `system-reminder` / hook-output blocks in user records, sized per hook name | "SessionStart hook X injects 4.1k tokens per session; disable plugin Y to save Z per session." |
| Skill loads | `Skill` tool calls and `<command-name>` blocks | "Skill Q was loaded 14 times and used 2." |
| Polling | repeated identical `Bash` commands on jobs that notify | "35 of 84 Bash calls were status checks; cost 1.2M re-sent tokens." |
| Context growth | ctx per call, `compact_boundary` pre/post | "Compacting at 200k instead of 430k would have saved N." |
| Subagent cold starts | `subagents/*.jsonl` first calls | "Subagent X re-derived 60k tokens; give it file paths." |
| Cache misses | `cache_creation` spikes with no compaction (same rule the CLI uses: > 5 % and ≥ 2k) | "12 misses cost $X; causes: idle > 5 min, system prompt changed." |
| Model mix | `model` per call | "41 % of mechanical calls ran on Opus; route to Sonnet." |
| Unread tool output re-sent | large tool_result blocks by tool | "Read of file F (18k tokens) was re-sent 60 times." |

### 3.2 What needs the proxy tier
- **Per-MCP-server tool-schema bytes.** Tool schemas are in the request body, not the transcript.
  `req-start` already records bytes per tool name; group by the `mcp__<server>__` prefix. This is
  the finding that matters most (this machine: 590 KB of schemas per cold start) and only the
  proxy can see it. Recommendation text: "MCP server S adds 61k tokens to every session; add it to
  `disabledMcpjsonServers` for projects that do not use it, or use `--strict-mcp-config` for
  `claude -p`."

### 3.3 Shape
- `token-meter audit [--days 7] [--project X]` → `audit.json` + a rendered report page in the
  dashboard ("Audit" tab) with each finding as: evidence, tokens per session, tokens per week at
  your rate, the exact settings change, and a confidence note.
- A skill `/token-meter:audit` that runs the command and phrases the top five findings for the
  user's situation. The skill NEVER edits settings; it prints the change.
- Rules are deterministic and testable (a fixture per rule, CE-017: each proven to fire).

---

## 4. Publishing — skill, plugin, npm, or binary?

Facts that decide it (https://code.claude.com/docs/en/plugins-reference.md):
- A plugin can ship skills, commands, agents, hooks, MCP servers, `bin/` executables (added to
  the Bash tool's PATH), and `monitors/` (persistent background processes per session).
- A plugin **cannot** set `statusLine` or `env`; plugin `settings.json` allows only `agent` and
  `subagentStatusLine`. So a wiring command is required no matter what.
- The closest working analog on this machine is claude-mem: a SessionStart hook spawns a
  self-restarting worker; its status line script ships with the plugin and the user wires it by
  hand.

**Recommendation: a GitHub repo that is at once a plugin marketplace and an npm package.**

| Channel | Who it serves | What they type |
|---|---|---|
| Plugin (primary) | anyone inside Claude Code with Node | `/plugin marketplace add NoobProTim/<name>` then `/plugin install <name>` then `/token-meter` |
| npm (secondary) | npm-install users, CI | `npx <name> serve` / `npx <name> wire` |
| Binaries in Releases (phase 2) | native-installer users with no Node | download, `./token-meter wire` |
| Skill only | nobody: a skill cannot carry a runtime | rejected |

Repo layout:
```
.claude-plugin/plugin.json   name, version, description
.claude-plugin/marketplace.json
skills/token-meter/SKILL.md          /token-meter: open dashboard, explain a line, wire/unwire
skills/token-meter-audit/SKILL.md    /token-meter:audit
hooks/hooks.json                     SessionStart → ensure-dashboard (idempotent, port-checked)
monitors/monitors.json               proxy supervisor fallback, when: always
bin/token-meter                      shim: node "$CLAUDE_PLUGIN_ROOT/src/cli.cjs" or the SEA binary
src/{meter,proxy,statusline,audit,wire,doctor}.cjs   zero dependencies
test/fixtures/                       transcripts across CLI versions, fake upstream, fake gateway
package.json                         "bin": {"token-meter": "src/cli.cjs"}, no deps
LICENSE (MIT), README.md, SECURITY.md, CHANGELOG.md
.github/workflows/ci.yml             matrix os × node; selftests; secret scan; scrub grep
```

Name candidates (founder decides): `claude-token-meter`, `ccmeter`, `tokentap`. Check npm and
GitHub for collisions before choosing.

---

## 5. Order of work

1. **Now, local:** the lead re-verifies the builder's final files (selftests, reconcile, lag ≤ 2s,
   statusline < 0.1s, no stray servers), then P0 #4/#7/#9/#13 (crash-proofing, config dir, scale,
   scrub) — pure code, no wiring.
2. **Local rollout on this machine (founder approval given for the proxy earlier; needs a fresh yes
   because Remote Control goes off):** wire transcripts tier + status line; run a week with the
   proxy only if the founder accepts the feature loss.
3. **Repo:** P0 #1-#3, #5, #6, #8, #10-#12; CI; README. Private repo first.
4. **Audit v1:** the nine transcript rules, then the MCP-schema rule on the proxy.
5. **Public:** founder reviews the scrub grep and README, gives an explicit yes, repo flips public,
   plugin marketplace tested from a clean VM, npm publish.
6. **Phase 2:** binaries via Node SEA in Releases; Homebrew tap; WinGet.

## 6. Verification before public
- Clean macOS VM with the native installer and NO Node: `/plugin install` → clear message naming
  the Node requirement; binary path works.
- Clean Ubuntu container with npm install: dashboard live, watch fallback notice printed.
- Windows 11 runner: statusline renders, wire writes absolute paths, unwire restores.
- Corporate-gateway simulation: fake gateway + fake HTTPS_PROXY + mTLS pair; counts equal.
- Bedrock simulation: transcript with ARN ids → priced by base model.
- Kill test: proxy killed under load → Claude Code recovers within one retry after supervisor restart.
- Privacy: `curl` without token 401; grep of `live.jsonl` for `authorization|x-api-key|cookie|"content":` → 0.
- Scrub grep → 0; screenshots regenerated from fixtures.

## 7. Founder decisions needed
1. Proceed to a private repo now, then public after review? (Nothing is pushed without a yes.)
2. Name.
3. Accept the proxy tier's feature loss on your own machine (Remote Control off) for the pilot week,
   or run transcripts-only here?
4. License (MIT proposed).
