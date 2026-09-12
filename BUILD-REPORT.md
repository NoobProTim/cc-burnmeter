# Token Meter — Build Report

Built to `~/.claude/token-meter/SPEC.md`, as revised by three founder rulings during the
build (drop the %-of-5h calibration entirely; token-only viewer; add the Tier-2 live
proxy) and one lead review of `proxy.cjs`. This report covers both tiers, every fix
requested during review, and the verification evidence for each.

Files: `meter.cjs`, `meter.html`, `statusline.cjs`, `proxy.cjs`. No npm dependencies.
Nothing was left running; no `live.jsonl`/`limits.jsonl`/cache file exists under
`~/.claude/token-meter/` at rest (see "Cleanup" at the end).

---

## 1. How to run each view

```bash
# Terminal live view (redraws at most 2x/sec)
node ~/.claude/token-meter/meter.cjs

# Dashboard, binds 127.0.0.1 only
node ~/.claude/token-meter/meter.cjs --serve 4777
# then open http://127.0.0.1:4777/

# Dump normalized calls as JSONL
node ~/.claude/token-meter/meter.cjs --json --since 2h
node ~/.claude/token-meter/meter.cjs --json --since 1970-01-01 --file <transcript.jsonl>

# Engine selftest (10 assertions)
node ~/.claude/token-meter/meter.cjs --selftest

# Live proxy (Tier 2) -- NOT installed or run against real traffic by the builder.
# The lead runs `node proxy.cjs --selftest` (fake upstream only) or installs it via
# launchd + ANTHROPIC_BASE_URL themselves.
node ~/.claude/token-meter/proxy.cjs --selftest

# Status line (wired into ~/.claude/settings.json by the lead, not this build)
echo '<stdin JSON>' | node ~/.claude/token-meter/statusline.cjs
```

Environment overrides used only for testing (never touch real state):
`TOKEN_METER_PROJECTS_DIR`, `TOKEN_METER_LIVE_FILE`, `TOKEN_METER_STATUSLINE_CACHE`.

---

## 2. Founder rulings that reshaped the build, in order

1. **Original spec** (§3 item 3): tokens / API-$ / %-of-5h unit toggle, with a
   least-squares calibration fit to real 5-hour limit hits.
2. **Ruling 1**: replace that calibration with a different one — proxy `Q = input +
   cache writes + 5×output`, least-squares + leave-one-out, `--calibrate` CLI. Built
   and verified (see §3 below) before the next ruling superseded it.
3. **Ruling 2 (final)**: *"If I just needed the percentage viewer, I would have used
   the default viewer in settings usage. What I need is a real time token consumption
   viewer."* Drop the %-of-5h unit, calibration, `--calibrate`, the forecast tile,
   `limits.jsonl`, and the 5h/7d tiles **entirely**. Tokens are the unit everywhere;
   API-$ survives only as one plain column. Add: header tiles (last-60m tokens split
   fresh/re-sent/output, tokens/min over 5 min, biggest call, sessions active now); an
   in-flight indicator; a tokens-only status line. **All calibration code was deleted**,
   not left dormant.
4. **Ruling 3 (scope addition)**: build SPEC §9, the live proxy (`proxy.cjs`) — Tier 2.
5. **Lead review of `proxy.cjs`**: raise the idle timeout from 10s to 600s (10s was
   killing legitimate slow-to-first-byte or long-thinking-pause responses); abort the
   upstream when the client disconnects (Esc/retry must not keep billing for unread
   output). Two new selftests added and proven to fail first.

The §3 calibration work (build, 30-day real-data validation, 21 limit-hit windows
found, Q proxy LOO median error 13.3% vs the lead's own measured 18%) is **not** part
of the delivered product — it was fully built, measured against real data, then
deleted per ruling 2. Noted here only so the discarded work and its real numbers are
on record, per "delete rather than leave dormant."

---

## 3. Tier 1 verification (`meter.cjs`, `meter.html`, `statusline.cjs`)

### 3.1 Selftest — `node meter.cjs --selftest` (10/10 pass)

```
ok   - dedupe by message.id+requestId, tools merged
ok   - cache write pricing multipliers (1h=2x, 5m=1.25x of input)
ok   - unknown model -> costUSD null
ok   - fedIn mapped by tool_use_id
ok   - tool_result user record does not start a turn
ok   - partial trailing line buffered not dropped
ok   - quotaLimits on a synthetic assistant message still emits limit-hit
ok   - in-flight: user record with no call after it, then clears on call
ok   - in-flight: a stale pending record (hours old) is NOT in flight
ok   - cw5m recovered as (total - cw1h) when the split undercounts it
ALL 10 SELFTESTS PASSED
```

Every assertion was proven to fail once on a deliberately broken variant before the
real code was shown to pass (CE-012/CE-017), via a standalone break-test harness that
never modified the real files:

| # | Assertion | Fail-then-pass method | Actual failure text observed |
|---|---|---|---|
| 1 | dedupe by id+requestId, tools merged | "first-wins" variant that never merges later content-block info | `tool name Bash should be merged from the second line` |
| 2 | 1h=2x, 5m=1.25x pricing | flat input-rate applied to cache writes | `1h write of 1e6 tokens should cost $4, got 2` |
| 3 | unknown model → null | a variant that guesses sonnet-4-6 pricing | `expected costUSD null for unknown model, got 0.01` |
| 4 | fedIn by tool_use_id | tool_use_id→name map never populated | `expected fedIn tool name Read, got unknown` |
| 5 | tool_result ≠ turn | no shape-check, any user record starts a turn | `tool_result record must not replace currentTurn` |
| 6 | partial line buffered | naive split with no carry-over buffer | reconstructed line `partial` never seen; got `part,ial` |
| 7 | quotaLimits on synthetic | (real bug, see §4) | 0 limit-hit events emitted before the fix |
| 8 | in-flight clears on call | omitted entirely before the fix | n/a — feature didn't exist |
| 8b | stale in-flight not flagged | unbounded variant (no age/mtime check) | `expected a 3-hour-old pending record to NOT read as in-flight` |
| 9 | cw5m recovery | trust-the-split variant (the real bug, see §4) | `expected cw5m recovered as 6903-5070=1833, got 0` |

### 3.2 Reconcile — transcript `850da9a8-9361-441a-856e-99dd6e537d0b.jsonl` (final)

Independent `python3` sum (own dedupe, own field extraction, never imports meter.cjs)
vs. `node meter.cjs --json --since 1970-01-01 --file <transcript>`, summed per model:

```json
{
  "claude-sonnet-5": {"input":3681,"cw5m":9347,"cw1h":5844231,"cr":777505697,"out":1406605,"calls":1838},
  "claude-fable-5-1": {"input":9821,"cw5m":0,"cw1h":1739650,"cr":57804054,"out":281158,"calls":167},
  "claude-opus-5": {"input":10802,"cw5m":28062,"cw1h":14405806,"cr":1174259525,"out":2604740,"calls":2677}
}
```
`RECONCILE: IDENTICAL` — all six fields (input, cw5m, cw1h, cr, out, calls) equal for
every model, re-confirmed in §7 as a same-moment snapshot after the post-review fix
pass. **Caveat on what this reconcile actually proves**: `reconcile.py` derives cw5m
with the identical `max(0, total − cw1h)` formula as `meter.cjs`, so an error in that
*derivation itself* would reproduce identically on both sides and this check cannot
catch it — it only proves the two implementations parse and dedupe the same records the
same way (a real and non-trivial check, but not derivation correctness). The evidence
for the derivation itself being correct is independent: the lead's own
separately-measured figures (9,347 sonnet / 28,062 opus, from a different method) match
what this code now produces — see §4.A.

### 3.3 Live SSE — real events, not synthetic

Captured while the coordinator/this session made ordinary tool calls:

```
inflight 2026-09-12T18:43:14.856Z
call     2026-09-12T18:43:18.084Z
inflight 2026-09-12T18:43:18.240Z
call     2026-09-12T18:43:21.280Z
inflight 2026-09-12T18:43:21.353Z
call     2026-09-12T18:43:24.915Z
```
Each `call` event carried the real transcript payload (model, ctx, tools, fedIn) and
arrived within ~1s of the underlying tool call. A separate clean 60s window (no tool
activity from this session during that specific window) saw zero new calls — reported
plainly rather than manufactured; the SSE connection itself stayed open and healthy
throughout (confirmed via a later successful capture in the same run).

### 3.4 Status line samples

```
Opus 5 │ ctx 244.0k │ last: +1.7k new · 245.0k re-sent → 4.4k out (3.2k think) │ session: 246.7k in · 4.4k out
Sonnet 5 │ ctx 1.0k │ session: 0 in · 0 out
token-meter: n/a                    (garbage stdin, exit 0)
```
Cold call on the real 224MB lead transcript: **41ms**. Warm repeat call: **40ms**. Both
under the 100ms budget (see §4.D — this required a redesign, not just caching).

### 3.5 Screenshots — `~/.claude/token-meter/shots/`

`desktop-light.png`, `desktop-dark.png`, `mobile-light.png` (400px), `mobile-dark.png`,
`desktop-session-detail-light.png`, `desktop-session-detail-dark.png`. Palette
validated against the `dataviz` skill's validator (categorical adjacent-pairlist:
worst CVD ΔE 9.1 light / 8.4 dark, both above the 8.0 target; contrast WARN on 3
light-mode slots mitigated per the skill's relief rule via the always-available table
view). Both themes render correctly; sessions table now shows 4 active of 168 total by
default (see §4.F).

---

## 4. Fixes requested during Tier-1 review (lead tested at 14:20)

### A. cw5m undercount — real correctness bug

`usage.cache_creation.ephemeral_5m_input_tokens` disagrees with the reported total in
~1% of real records (measured: 96/9,842). Example from the lead transcript:
`cache_creation_input_tokens: 6903`, split reports `{1h: 5070, 5m: 0}` — silently
dropping 1,833 tokens. Fixed in `meter.cjs`'s `buildCall` (and `proxy.cjs`'s
`handleSSEData`, same pattern, same fix, per the Bug Fix Quality Rule) to always derive
`cw5m = cache_creation_input_tokens − cw1h`, never trusting the split's own 5m field.
Reconciled against the lead's independently-measured 9,347 (sonnet) / 28,062 (opus) —
exact match, see §3.2.

### B. Stuck in-flight — 8 sessions frozen since 03:45Z

`inFlightSince()` now requires the pending record to be **under 10 minutes old** AND
the transcript file itself **modified in the last 10 minutes**; either check failing
clears the flag. Selftest 8b proves it (a 3-hour-old pending record with an untouched
transcript no longer reads as in-flight).

### C. Live lag for a NEW session — was 8.1s, spec ≤2s

New files only entered the tailer via the 10s rescan (`pollGrowth` only iterates
already-known `entries`). Fixed: `fs.watch`'s recursive callback now registers a
brand-new `.jsonl` file immediately via `registerIfNew()`, with the 10s rescan kept
only as a fallback. Measured with a temp projects dir
(`TOKEN_METER_PROJECTS_DIR`) and a live SSE listener:

```
APPEND lag ms: 17
NEW FILE lag ms: 15
```
Both scenarios (append to existing file, brand-new file) measured, both far under 2s.

### D. Status line 0.45s (spec <0.1s) — historical catch-up scan

Redesigned rather than just cached: a **single** consolidated cache file
`~/.claude/token-meter/.statusline-cache.json` (keyed by sessionId, holding
`{offset, sumIn, sumOut, lastKey}`). A session's cache entry, when first created,
starts at the **current** file size rather than scanning backward — this trades
"session total since true session start" for "session total since token-meter first
saw it," which is the only way every call (cold or warm) stays bounded by new bytes
only, never by total transcript size. Measured on the real 224MB transcript: cold
41ms, warm 40ms (both include ~35ms of pure Node startup).

### E. Left a server running

`meter.cjs --serve 4777` (pid 2576) was left running after a screenshot session; the
lead killed it. Every server started for verification since has been explicitly killed
(confirmed via `lsof -nP -iTCP:<port> -sTCP:LISTEN` + `ps aux` after each session) — see
"Cleanup" at the end for the final confirmation. No `trap`-based auto-cleanup was used
for interactive multi-step verification (a trap scoped to one Bash tool call would kill
a server needed across the next call); instead every server was explicitly torn down
before moving on, and re-verified clean at the end of the whole build.

### F. Sessions table — 166 rows unusable

Defaults to sessions active in the last 60 minutes (or currently in flight); a
"Show all" / "Show active only" toggle reveals the rest, with a live count
(`Show all (168 total, 4 active)`). Confirmed in the screenshots (§3.5).

---

## 5. Tier 2 — live proxy (`proxy.cjs`)

### 5.1 Selftest — `node proxy.cjs --selftest` (9/9 pass, fake upstream only)

```
ok   - 1. SSE pass-through byte-identical, no buffering (event1 < 500ms despite 1s gaps)
ok   - 2. anthropic-beta/version/authorization/session-id headers pass through; host rewritten
ok   - 3. request body reaches upstream byte-identical (hash match)
ok   - 4. records correct: req-start breakdown, usage-start exact, progress, usage-end cumulative
ok   - 5. gzip response byte-identical passthrough, decompressed copy parsed
ok   - 6. upstream unreachable -> 502 JSON error within 2s
ok   - 7. secret sentinel: auth header + body text never written to disk
ok   - 8. client abort closes the upstream connection within 1s
ok   - 9. a 12s-late first byte still completes (600s idle timeout, not 10s)
ALL 9 PROXY SELFTESTS PASSED
```

Every check made to fail once first:

| # | Check | Fail method | Actual failure |
|---|---|---|---|
| 1 | SSE no-buffering | relay that accumulates all chunks before writing | `expected first byte under 500ms, got 1210ms` |
| 2 | header passthrough | allowlist that keeps only `content-type` | `authorization must pass through unchanged` |
| 3 | body byte-identical | `JSON.parse` → `JSON.stringify` before forwarding | hash mismatch after re-serialization |
| 4 | req-start/usage-start/progress/usage-end | `buildBreakdown` that never reads `tools` | `expected req-start breakdown to name the Bash tool` |
| 5 | gzip passthrough + parsed copy | **real bug** — see below | `expected the decompressed copy to be parsed for inputTokens, got {req-end with no inputTokens}` |
| 6 | 502 within 2s | (passed first try; infra bug below masked it) | n/a |
| 7 | secret sentinel | **real bug** — see below | grep found the sentinel in `proxy.cjs`'s own source and `SPEC.md` (false positive from scanning source, not runtime output) |
| 8 | client-abort closes upstream | proxy with no `res.on('close')` handler at all | `upstream connection never closed... (never closed = broken)` |
| 9 | 600s idle timeout | proxy using the old 10s value | `got 502 ({"error":{"message":"upstream idle timeout"}})` |

**Two real bugs found and fixed during development** (in addition to the deliberate
fault-injection above):
- **Port-resolution bug**: `startProxy({port:0})` resolved with the *requested* port
  (0) instead of `server.address().port`, so every test dialed `127.0.0.1:80` and got
  `ECONNREFUSED`. Fixed; this is what masked check 6's real behavior until fixed.
- **Gzip finalize race**: `decomp.end()` was called and the finalize logic ran
  synchronously right after, before the decompressor's own final `'data'` event had
  necessarily fired — an async race that intermittently lost the last chunk. Fixed by
  waiting for `decomp`'s own `'end'` event before finalizing.
- **Sentinel-check false positive**: grepping the whole `~/.claude/token-meter` tree
  necessarily matches the sentinel strings inside `proxy.cjs`'s own test code and
  `SPEC.md`'s literal instructions. Fixed to exclude `.cjs`/`.md`/`.html` source files
  and scan only runtime output (the test's own `live.jsonl` fixture path + anything
  else under `METER_DIR`).
- **Missing `breakdownTokensEst`** (spec §9.2): was omitted from the first
  `usage-start` implementation entirely. Added — see §5.2.

### 5.2 Lead-review fixes

1. **Idle timeout 10s → 600s.** A large-context request's first byte, or a long
   thinking pause between stream bytes, can legitimately exceed 10s; Claude Code's own
   watchdog is 300s, so 600s gives headroom without risking a real cutoff. Connection
   failures (ECONNREFUSED/DNS) remain a **separate, immediate** path — Node fires that
   `error` event on connection refusal independent of any timeout, so check 6 (502
   within 2s) is unaffected by raising the idle value. Proven by selftest 9 (a 12s-late
   first byte now completes).
2. **Abort upstream on client disconnect.** `res.on('close')` (before the response has
   ended) and `req.on('aborted')` both now call `proxyReqRef.destroy()`, so a
   cancelled Claude Code request (Esc, a retry) doesn't leave the upstream generating
   and billing for output nobody reads. Proven by selftest 8 (upstream connection
   closes within 1s of the client's abort).

### 5.3 `breakdownTokensEst`

Added to the `usage-start` record: each request-side byte part (system, tools, cached
prefix, new tail) scaled by the ratio of exact reported tokens
(`input+cw5m+cw1h+cr`) to counted bytes. Verified by selftest 4's added assertion
(`breakdownTokensEst.tools > 0`).

### 5.4 Meter integration (live.jsonl tail, msgId join, ticking rows, "what was sent" bar)

Implemented in `meter.cjs`:
- `processLiveLine()` tails `live.jsonl` (byte-offset + `fs.watch`, 1s poll — finer than
  the transcript's 3s poll since live progress moves faster) and maintains a
  `liveCalls` map (`reqId → {status: pending|streaming|done, ...}`).
- **Bidirectional msgId join**: a transcript call looks up `liveByMsgId` at build time
  (works when live data arrives first, the common real-world order — the proxy sees a
  response in real time, the transcript line lands once Claude Code finishes writing
  it); a `callsByMsgId` reverse index lets a live `usage-start` retroactively attach
  `sentBreakdown` to an already-built transcript call (covers the reverse order, or
  same-tick races). Both directions verified — see below.
- **Ticking rows**: `/api/state`'s `live` array (non-done entries only) drives the
  dashboard's live-feed banner (updates every 500ms) and the terminal view's per-session
  STATUS column (`⏳ streaming 1.2k out~ (3.4s)` in place of the coarser elapsed-time
  badge once live data exists for that session).
- **"What was sent" bar**: session detail gained a new stacked-bar card (system │ tools
  │ cached history │ new tail, in est. tokens) sourced from `call.sentBreakdown` for
  finished, joined calls and from the live entry directly for still-in-flight ones
  (shown at reduced opacity to distinguish in-progress from settled data; a finished
  call is shown once, not doubled, once its transcript join lands).
- **Fallback**: every function above is a no-op when `live.jsonl` doesn't exist —
  `fs.statSync` failing inside the poll loop just returns; Tier 1 is unaffected. This
  is the only mode the lead or founder will see until the proxy is actually installed
  and carrying real traffic, since **no real traffic was ever sent through it** (hard
  limit, respected throughout).

**Verified end-to-end with a synthetic `live.jsonl`** (hand-written JSON lines matching
the documented record shapes exactly — never real traffic, never through the actual
proxy process) paired with a matching synthetic transcript, using a temp projects dir:

```
live entries (non-done): 1
  - live-req-2 streaming outEst: 15
transcript call sentBreakdown: {"systemBlocks":...,"tools":[{"name":"Bash",...}],...}
```
then, after the sentBreakdown-shape fix (see below):
```
sentBreakdown now: {"system":47,"tools":17,"cachedPrefix":47,"newTail":58}
```
Screenshot of the resulting "what was sent" chart confirms three bars render correctly
(two settled + one at reduced opacity for the still-streaming call) —
`~/.claude/token-meter/shots/tier2-detail4.png` was captured during development and
matches the shape now shown in `desktop-session-detail-*.png` for a real session (which
correctly shows "No live proxy data for this session" since it had none).

**Two more real bugs found and fixed during this end-to-end test:**
- `call.sentBreakdown` was being set to the raw byte `breakdown` object (systemBlocks/
  toolsTotal/...) instead of the token-scaled `breakdownTokensEst` the chart actually
  reads — the chart's keys (`system`/`tools`/`cachedPrefix`/`newTail`) never matched,
  so nothing rendered despite the legend showing. Fixed in both join directions.
- `openSession()` set `sessionDetail.style.display = ''` to reveal the panel, which
  only *clears an inline override* — with no other inline style set, the element fell
  back to its stylesheet rule (`display: none`) and the panel silently never appeared,
  in EVERY session-detail screenshot taken before this was caught (Tier 1 included).
  Fixed to `style.display = 'block'`. This was not something either the lead or I had
  actually clicked-and-looked-at before; the automated screenshot script always
  captured the closed default state, and every earlier screenshot review only checked
  the sessions list, never the detail panel. Re-verified: `document.getElementById(
  'sessionDetail').style.display` now reports `"block"` after a click, and the
  screenshots in §3.5 show real chart content in the panel.

---

## 7. Post-review fix pass (independent review, before final handoff)

Four issues surfaced by an independent review of this build, none caught by the
selftests above because all four are either a silently-ignored flag, a rare data shape,
or unbounded growth that a short-lived test process never lives long enough to show.

### 7.A `--hours` silently ignored by `--serve` and the terminal view

`runTerminalView()` and `startServer(port)` both hardcoded `startTailer(24)`; the
`--hours` CLI flag (real, documented, and honored by `--json`) was parsed nowhere in
either path. **This was live**: the process found running at report time
(`node meter.cjs --serve 4780 --hours 6`, §"Cleanup") believed it was getting a 6-hour
window and was silently getting 24. Fixed — both functions now take `hours` and read it
via `opt(args, '--hours', 24)`. Verified the flag now changes real behavior:
```
discoverFiles({hours:1}):   5 files
discoverFiles({hours:24}):  168 files
discoverFiles({hours:168}): 1488 files
```
and confirmed the exact live command's argv now parses to `{port:4780, hours:6}`
instead of the old `{port:4780, hours:24}`.

### 7.B cw5m can go negative — clamped, and a missed instance found

`cw5m = total − cw1h` (§4.A's fix) has no floor. Scanned all of `~/.claude/projects`
(68,618 cache_creation-bearing records): **4 real records** have `cw1h` exceeding the
reported total (worst: total short by 4,576 tokens), which would drive `cw5m` negative
and corrupt `fresh`/`ctx`/`costUSD` downstream. Clamped with `Math.max(0, ...)` in
`meter.cjs::buildCall` and `proxy.cjs::handleSSEData`.

Per the Bug Fix Quality Rule, grepped for the same pattern in `statusline.cjs` and found
it had **not** received the original §4.A fix at all — `extractCallTokens` still read
`cc.ephemeral_5m_input_tokens` directly (the unreliable field) instead of deriving from
the authoritative total, meaning the status line's `ctx`/session-total figures were
still exposed to the original undercount bug on every affected call. Fixed to match, with
the same clamp.

Fail-then-pass proof (`scratchpad/break-cw5m-clamp.cjs`): the unclamped formula on the
worst real case yields `-4576`; clamped yields `0`; a grep confirms all three files now
carry `Math.max(0, totalCacheCreation - cw1h)`. `node meter.cjs --selftest` (10/10) and
`node proxy.cjs --selftest` (9/9) both still pass unchanged.

The reconcile dump used in §3.2 happens to contain zero negative-cw5m records, so the
clamp is a no-op on that specific data — it does not, and could not, show up as a
reconcile diff. Confirmed instead by the direct corpus scan above.

### 7.C Three unbounded maps

`callsByMsgId`, `liveCalls`, and `liveByMsgId` are module-level `Map`s fed continuously
by a live proxy and never evicted, unlike `state.events` (capped 500), `s.turns` (capped
300), and `s.liveCalls` (capped 30). Fixed:
- `callsByMsgId` capped at 5,000 entries, oldest evicted on insert (same pattern as the
  existing `s.liveCalls` cap).
- `liveCalls`/`liveByMsgId` entries are removed 2 minutes after their `req-end` record
  lands (an unref'd `setTimeout`, so it never keeps the process alive), giving a
  slightly-late transcript join time to complete first.

`node meter.cjs --selftest` still 10/10 after the change.

### 7.D Reconcile re-verified as a single same-moment snapshot

The original §3.2 reconcile compared a fresh run against a stale prior snapshot,
producing spurious drift (this is a live, growing session transcript) unrelated to any
of the fixes above. Re-run correctly: froze the transcript to a static copy
(`reconcile-snapshot-final2.jsonl`, 42,337 lines), then ran meter's own
`processLine`/`buildCall` and the updated `reconcile.py` (now also clamped, §7.B)
against that identical unmoving file:
```
models meter:  [ 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5' ]
models python: [ 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5' ]
IDENTICAL across all fields per model
```
See §3.2's caveat on what this class of check does and does not prove.

---

## 8. Known limits

- **Tier 2 has never carried real traffic.** Per the hard limits (no real traffic, no
  `ANTHROPIC_BASE_URL`, no launchd), `proxy.cjs` has only been exercised against a fake
  local upstream inside `--selftest`, plus a hand-written synthetic `live.jsonl` for
  the meter-integration test above. The lead should do a short controlled real-traffic
  trial before trusting it for every session, per SPEC.md's own installation note.
- **Session-total tokens in the status line are "since token-meter first saw this
  session," not "since true session start."** A deliberate trade for the <100ms
  requirement (§4.D) — the alternative (a one-time historical catch-up) is
  fundamentally bounded by transcript size, not call count, and can't be made fast on
  a pre-existing multi-hundred-MB session.
- **In-flight / live ticking depends on the tailer actually running.** A one-shot
  `node meter.cjs --json` invocation never sees in-flight or live state; only the
  terminal view and `--serve` maintain it.
- **`--json` without `--file` discovers via `--hours` (default 168h / 7 days).** A
  `--since` older than that without an explicit `--file` will silently miss older
  files — fine for the terminal/dashboard's own use (always paired with `--file` or a
  bounded window) but worth knowing if scripted differently later.
- **Mobile layout (400px) is functional, not polished** — the live-feed grid columns
  are tight at that width. No horizontal page scroll; the sessions table has its own
  scroll container as designed.
- **The discarded §3-calibration code's real numbers** (21 hits, Q proxy 13.3%/37.7%
  LOO median/worst vs. the lead's own 18%/35%) are preserved only in this report and in
  conversation history, per "delete rather than leave dormant" — there is no
  `--calibrate` command in the shipped `meter.cjs`.

## Cleanup — confirmed at report time

Every server *this build started* was explicitly killed after use (verified by
`lsof -nP -iTCP:4777/4778 -sTCP:LISTEN` returning empty, repeatedly, throughout the
build — including after §3.5's and §5.4's screenshot sessions). No `.jsonl` file
(`live.jsonl`, `limits.jsonl`, or a leftover test fixture) exists under
`~/.claude/token-meter/`:

```
$ ls ~/.claude/token-meter/*.jsonl
no matches found
$ ls ~/.claude/token-meter/
BUILD-REPORT.md  meter.cjs  meter.html  proxy.cjs  shots  SPEC.md  statusline.cjs
```

**One process was found running at report time that this build did not start:**
`node meter.cjs --serve 4780 --hours 6` (pid 5229, started 14:54:49). Port 4780 and
the `--hours` flag were never used in any command this build ran (every run here used
4777, or the disposable 4777x range for isolated fixture tests) — this is almost
certainly the lead's own concurrent verification, on a different port specifically to
avoid colliding with this build's testing. It was left running deliberately rather
than killed, since killing another party's active session without knowing whose it is
would be presumptuous, not tidy.

No settings file was touched (`~/.claude/settings.json` wiring is the lead's step);
`ANTHROPIC_BASE_URL` was never set in any shell used for this build; no launchd plist
was created.
