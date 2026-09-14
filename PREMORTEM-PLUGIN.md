# CC-Burnmeter — plugin pre-mortem

Written 2026-09-14 by the factory lead (Fable 5.1) at the founder's request, after the 0.2.0
packaging landed (`67df3f5`). Scope: the **plugin layer** — manifest, marketplace, SessionStart hook,
skill, `bin` shim, update and removal paths. The tool itself (engine, proxy, wire) had its own
pre-mortem on 2026-09-12; this one does not repeat it.

Method: imagine it shipped and failed, then **test the failure before writing it down**. Every row in
§1 was run on this machine today; §2 marks each risk CONFIRMED (reproduced), FIXED, or UNTESTED.

---

## 0. The one-paragraph verdict

**Update, same day:** the P0 set below is applied (`9173d38`), the repo is public, and the install
was run from GitHub into a real project. That install found a **second** blocker the validator cannot
see (a duplicate-hooks load failure, fixed in the manifest) — which is the whole argument for §4
step 3. Hook rewritten in Node, ownership handshake on the port, token never logged, autostart
opt-out, `stop`, version-match test: 54/54 tests.

The plugin would have failed at the first command. `claude plugin validate` rejected the marketplace
manifest (`name` missing, `owner` not an object, `source` given as an object instead of the string
`"./"`), so `/plugin marketplace add NoobProTim/cc-burnmeter` would have errored for every reader of
the carousel. That is fixed and validated. Behind it sit three more real defects, all reproduced:
the hook trusts any HTTP server on port 4777, the "node not found" message would land in the model's
context on every session and every compaction, and the dashboard log records the access token in a
world-readable file. None is hard. **Do not flip public until §3 P0 is done and the install has been
run once from GitHub on a machine that is not this one.**

---

## 1. What was actually tested today

| Probe | Result | Consequence |
|---|---|---|
| `claude plugin validate .` on 0.2.0 as committed | **3 errors** in marketplace.json | install impossible → FIXED, re-validated: passes |
| Hook with a foreign HTTP server (python `http.server`) on the port | exit 0, silent, no dashboard started | any 200 on `/` passes as "dashboard is up"; `url` then prints a token for someone else's server |
| Hook with `node` hidden from PATH | prints the "node not found" line, exit 0 | SessionStart stdout is added to context → one line per session AND per compaction (SessionStart matches `startup, resume, clear, compact, fork`) |
| Hook with `curl` hidden, node present, run twice | one dashboard; second run exits cleanly on `EADDRINUSE` | harmless, but a log line per session for curl-less machines |
| Hook wall time when the dashboard is already up | 12 ms | negligible even on every compaction |
| Does SessionStart fire under `claude -p`? (marker-file hook, temp config dir) | **yes** | every headless run — CI, the founder's own gate scripts — runs the hook and may start a dashboard on the runner |
| Live interactive sessions on this machine right now | 5 | five hooks race at reboot; the port check serialises them (see curl-less row) |
| `claude plugin details` | needs the plugin installed; `--plugin-dir` not accepted by this CLI build | token-cost inventory deferred to the install test |
| Dashboard log after a hook start | first line is `http://127.0.0.1:4777/?token=<hex>` | the bearer token is in a 0644 file under `CLAUDE_PLUGIN_DATA` |
| **Install from the public GitHub marketplace** (after the flip, project scope, this repo) | installs, then `Status: ✘ failed to load — Duplicate hooks file`: `hooks/hooks.json` is loaded automatically and `manifest.hooks` pointed at it too | a second install-blocking defect the validator does NOT catch; only a real install does → FIXED by dropping `hooks`/`skills` from `plugin.json` (both default paths are auto-discovered) |
| `claude plugin details` after install | Skills 1, Hooks 1 (harness-only); always-on ~103 tokens per session, ~1.4k on `/token-meter` invoke | the plugin's context cost is two lines of the skill listing; acceptable |

---

## 2. How it fails, by the person who hits it

Format: who → what they do → what breaks → evidence → fix. Severity: **P0** blocks public, **P1**
before 1.0, **P2** later.

### 2.1 The reader of the LinkedIn carousel — CONFIRMED, FIXED
Types the three lines. `marketplace add` fails on the manifest. First impression is a stack trace.
- Fix landed: correct shape (`name`, `owner{}`, `source: "./"`), `claude plugin validate` in CI.
- Residual **P0**: the repo is private. The same command fails for everyone until the public flip,
  including a clean-VM test unless that VM is logged into GitHub as the founder. Test order matters:
  validate → install from local path → install from a *fork you can make public first* → flip.

### 2.2 The developer who already runs something on 4777 — CONFIRMED, P0
Grafana, a dev server, anything. The hook sees a 200, does nothing, and `/token-meter` prints
`http://127.0.0.1:4777/?token=…` pointing at their other app. The bearer token is handed to a page
that never asked for it.
- Fix: an unauthenticated `GET /api/hello` on the dashboard returning
  `{"name":"cc-burnmeter","version":"0.2.0"}`; the hook and `url` check the body, not the status.
  Proof: the python-server probe above must then start a dashboard on a different port and say so.

### 2.3 The native-installer user with no Node — CONFIRMED, P0
Every session and every compaction adds "cc-burnmeter: node not found on PATH…" to the model's
context. It is the exact behaviour the earlier pre-mortem warned against for hooks.
- Fix: print once. Write a marker in `CLAUDE_PLUGIN_DATA` after the first notice; stay silent after.
  Proof: run the hook twice with node hidden; second run produces no stdout.

### 2.4 The shared machine / the security reviewer — CONFIRMED, P0
`dashboard.log` starts with the access URL including the token, created by a shell redirect at the
default umask (0644). Everything else about the token is 0600.
- Fix: the server prints the token only when stderr is a TTY; otherwise it prints the URL without the
  token and says "run `cc-burnmeter url`". The hook creates the log with `umask 077`. Proof: grep the
  log for `token=` after a hook start → 0 hits.

### 2.5 The CI user and the founder's own pipeline — CONFIRMED (hook fires in `-p`), P1
`claude -p` runs fire SessionStart. On a CI runner the first run starts a dashboard nobody will open;
with `--setting-sources ''` plugins are skipped, so the founder's gate scripts are unaffected, but a
plain `claude -p` in a cron job is not.
- Fix: the hook exits immediately when `CC_BURNMETER_AUTOSTART=0` is set, and the README's CI
  section says to set it. Cheap, explicit, testable. (No documented way to detect print mode from a
  hook; do not guess.)

### 2.6 The Windows user — UNTESTED, P1
`hooks.json` runs `sh …/ensure-dashboard.sh`. Native Windows has no `sh`; the hook fails with an error
notice in the transcript every session. `bin/token-meter` is also a shell script.
- Fix: make the hook `node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-dashboard.cjs"` — Node is required
  anyway, and it removes the `curl` and `sh` dependencies in one move. Keep a `.cmd` shim next to the
  `bin` script. Proof: Windows runner in CI executes the hook and `token-meter url`.
  Trade-off: with no Node at all the hook command itself errors; §2.3's one-time notice becomes a
  one-time hook error instead. Acceptable, and it is the honest signal for that user.

### 2.7 The user who runs `/plugin update` — UNTESTED, P1
Plugins are cached under `~/.claude/plugins/`; the hook started the dashboard from the *old* cached
path. After an update the old process keeps serving old code until reboot, and the new hook sees a
200 and leaves it alone. The user reads a changelog that does not match the page.
- Fix: `/api/hello` carries the version; when it differs from the plugin's own, the hook kills the
  listener on that port (it verified it is ours) and restarts. Proof: bump the version in a local
  install, run the hook, confirm the new version is served.

### 2.8 The user who uninstalls — UNTESTED, P1
`/plugin uninstall` removes files. The dashboard keeps running until reboot (the process was
`nohup`'d), and the status line wired into `settings.json` now points at a path that no longer
exists, so every prompt shows a status-line error.
- Fix: `cc-burnmeter unwire` first is documented; add `cc-burnmeter stop` (kills the verified
  listener); README uninstall section lists the three steps in order. A SessionEnd hook cannot help:
  it cannot know it is the last session.

### 2.9 The user who wants to see their own prompts — P2
The hook starts the server without `--show-prompts`; there is no way to pass it through a plugin.
- Fix: `CC_BURNMETER_SHOW_PROMPTS=1` honoured by `meter.cjs`, documented with the shared-machine
  warning.

### 2.10 The team on org-distributed plugins — DOCUMENTED, P2
Plugins pushed through claude.ai organisation settings may not contain a top-level `bin/`. The
marketplace path is unaffected. README says so; the skill never depends on `bin`.

### 2.11 The maintainer, in three months — P1
The version lives in `plugin.json`, `marketplace.json` and `package.json`. Two will drift.
- Fix: one `npm test` assertion that the three match, and a `release` script that bumps all three.

### 2.12 The skill itself — UNTESTED, P1
The skill tells the model to run `node "${CLAUDE_PLUGIN_ROOT}/cli.cjs" …`. That substitution is
documented for hooks and monitors; whether it is expanded inside a skill body before the model sees
it is not something I verified. If it is not, the model runs a literal `${CLAUDE_PLUGIN_ROOT}` and
fails.
- Fix: verify on the first install. If unexpanded, the skill uses the `bin` shim (`token-meter url`),
  which is on the Bash tool's PATH by design, and falls back to `npx cc-burnmeter url`.

### 2.13 Five sessions at once — CONFIRMED benign
At reboot every open session runs the hook. The first wins the port; the rest exit on `EADDRINUSE`
with one log line each. No duplicate servers. Nothing to fix beyond §2.2's ownership check.

---

## 3. Ordered fix list, each with its proof

| # | Sev | Change | Proof it fires |
|---|---|---|---|
| 1 | P0 | `GET /api/hello` → `{name, version}` unauthenticated; hook + `url` check the body | foreign server on the port → hook starts ours on the next free port and prints which |
| 2 | P0 | "node not found" notice printed once (marker in `CLAUDE_PLUGIN_DATA`) | hook twice with node hidden → second run silent |
| 3 | P0 | token never written to the log; log created 0600 | `grep token= dashboard.log` → 0 |
| 4 | P0 | version-match test across the three manifests; `claude plugin validate` in `npm test` | edit one version → test fails |
| 5 | P1 | hook rewritten in Node (`ensure-dashboard.cjs`), no `sh`/`curl`; `.cmd` shim | Windows CI runner executes hook + `url` |
| 6 | P1 | `CC_BURNMETER_AUTOSTART=0` honoured; README CI section | `claude -p` with the var set starts nothing |
| 7 | P1 | version mismatch on `/api/hello` → hook restarts the (verified) server | local version bump → new version served |
| 8 | P1 | `cc-burnmeter stop`; uninstall section: unwire → stop → uninstall | after the three steps: no listener, no status-line error |
| 9 | P1 | verify `${CLAUDE_PLUGIN_ROOT}` expansion in the skill; fall back to `bin` shim | first install: `/token-meter` prints a URL |
| 10 | P2 | `CC_BURNMETER_SHOW_PROMPTS=1` | env set → previews on |

---

## 4. Verification before the public flip

1. `npm test` green, including validate + version-match.
2. Install from the **local path** on this machine; `/token-meter` prints a working URL; the hook
   starts nothing extra on the next session.
3. Install from **GitHub** on a second machine (or a fresh user account on this one) that has never
   seen the repo — this is the only test that proves the marketplace path, and it needs the repo
   public or a public fork.
4. Kill the dashboard, start a foreign server on 4777, open a session → the hook starts ours
   elsewhere and says so.
5. Hide Node, start two sessions → exactly one notice in the first transcript, none in the second.
6. `/plugin update` after a local version bump → new version served without a reboot.
7. unwire → stop → uninstall → no listener, no status-line error, `settings.json` byte-identical to
   the backup.
8. Windows runner: hook + `url` succeed.

## 5. Founder decisions

1. **Auto-start on by default, or opt-in?** Some developers dislike a plugin that starts a resident
   process on install. Proposal: on by default, `CC_BURNMETER_AUTOSTART=0` to opt out, stated in the
   README's first screen. The alternative is starting it only on the first `/token-meter`.
2. **Hook in Node or in sh?** Node removes the Windows and curl problems and Node is required anyway.
   Proposal: Node.
3. **Public flip only after step 3 of §4** — which needs a public fork or the real flip. Proposal:
   make the repo public with the README's "pre-release" banner, run the test, and hold the LinkedIn
   post until it passes.
