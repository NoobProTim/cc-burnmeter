# Token Meter — spec

Goal: a live, per-API-call view of Claude Code token use across every session on this Mac (lead, worker,
SMM, subagents), in three places: an HTML dashboard, the Claude Code status line, and a terminal table.
Founder request 2026-09-12. Written by the factory lead; build to this.

## ⚠ FOUNDER RULING 2026-09-12 — this is a TOKEN viewer, not a quota-% viewer (overrides the sections named below)

Founder: *"If I just needed the percentage viewer, I would have used the default viewer in settings usage. What I need is a
real time token consumption viewer."*
- **DROP entirely:**
  - §3 item 3 (the % of 5h unit, calibration, forecast tile, `--calibrate`);
  - `limits.jsonl` and the snapshot appending in §7;
  - the 5h/7d tiles in §5/§6;
  - the §8.4 limits test;
  - the %-unit toggle.
- **Tokens are the unit everywhere.** API-$ survives only as ONE secondary column plus a session total, with no toggle.
- **Header tiles (§6), all in tokens:**
  - tokens in the last 60 min, split into fresh / re-sent / output;
  - live rate (tokens/min over the last 5 min);
  - the biggest single call in the last hour;
  - sessions active now.
- **Real-time touch (§5/§6):** a session whose transcript's last record is a user prompt or tool_result with no
  assistant usage after it has a call IN FLIGHT. Show `⏳ in flight 12s` on that session row and at the top of the live
  feed, until the usage line lands. Then the row flips to the exact counts.
- **Status line (§7) shows tokens only:**
  `Opus 5 │ ctx 244k │ last: +1.7k new · 245k re-sent → 4.4k out (3.2k think) │ session: 31.2M in · 402k out`

**Location:** `~/.claude/token-meter/` (global, NOT inside any repo). **Zero npm dependencies**, Node ≥ 20 (installed: v26).

| File | Role |
|---|---|
| `meter.cjs` | Engine + CLI. `node meter.cjs` = terminal view; `--serve [port]` = dashboard (default 4777); `--json --since <2h\|ISO>` = dump normalized calls as JSONL; `--selftest` |
| `meter.html` | Dashboard, one file, inline CSS/JS, no CDN, no external fonts |
| `statusline.cjs` | Status line command |
| `limits.jsonl` | Rate-limit snapshots appended by `statusline.cjs` (the only source of live 5h/7d %) |

---

## 1. Data sources (verified 2026-09-12 on real transcripts; do not re-derive)

1. **Transcripts:** `~/.claude/projects/<project-slug>/<sessionId>.jsonl`. **Subagents:**
   `<project-slug>/<sessionId>/subagents/agent-<id>.jsonl`, plus `agent-<id>.meta.json`
   `{agentType, description, model}`. The project name is the slug with the homedir prefix stripped.
   The lead transcript is **224 MB**, so stream it line by line. Never read a transcript into one string.
2. **One API call** is a record with `type:"assistant"` and `message.usage`, where `message.model !== "<synthetic>"`.
   - **One response is written as SEVERAL lines**, one per content block (thinking / text / tool_use). They share
     `message.id` + `requestId` and carry IDENTICAL usage. Dedupe on that pair, and merge the content-block info
     (tool_use names and ids) across the lines.
   - Usage fields:
     - `input_tokens`: uncached.
     - `cache_creation_input_tokens`, split into `cache_creation.ephemeral_5m_input_tokens` and `.ephemeral_1h_input_tokens`.
     - `cache_read_input_tokens`.
     - `output_tokens`: includes thinking; `output_tokens_details.thinking_tokens` gives the thinking share.
     - `server_tool_use.web_search_requests`, `speed` (`"standard"`/`"fast"`), `service_tier`.
3. **Turn start:** a `type:"user"` record whose `message.content` is a string or text/image blocks, with `isMeta` not true.
   It usually carries `promptSource` (e.g. `"typed"`). Tool results are ALSO `type:"user"`, but with
   `tool_result` blocks (`tool_use_id`, `content`) plus `toolUseResult`; those are NOT turns.
4. **`type:"system"` records:**
   - `subtype:"compact_boundary"` → `compactMetadata {trigger, preTokens, postTokens}`;
   - `subtype:"turn_duration"` → `{durationMs, messageCount}`.
5. **Limit hits:**
   - An assistant record may carry `quotaLimits {status, rateLimitType:"five_hour", resetsAt (epoch s), …}`.
   - `<synthetic>` assistant messages hold limit text such as "You've hit your session limit · resets 3:20am".
   - Show both as events.
6. **Injected context:** `type:"attachment"` with `attachment.type` — `hook_success`, `hook_additional_context`,
   `total_tokens_reminder`, `skill_listing`, `invoked_skills`, `deferred_tools_delta`, and so on.
   Size = the line's byte length; show it as ≈ bytes/4 tokens, labelled "est.".
7. **Labels:** `type:"agent-name"` records give a session's display name; `type:"ai-title"` records give its title.
8. **Status line stdin JSON** (code.claude.com/docs/en/statusline):
   - `session_id`, `transcript_path`, `model.display_name`, `cost.total_cost_usd`;
   - `context_window {total_input_tokens, context_window_size, used_percentage, current_usage{…}}`;
   - `rate_limits.five_hour` and `rate_limits.seven_day`, each `{used_percentage, resets_at (epoch s)}`.
   - `rate_limits` appears only for Pro/Max, only after the first response, and either window may be absent.

## 2. Pricing (USD per million tokens; platform.claude.com pricing page, fetched 2026-09-12)

Match the model id most-specific first:

| model id contains | input | 5m write | 1h write | cache read | output |
|---|---|---|---|---|---|
| `fable-5-1`, `mythos-5-1` | 10 | 12.50 | 20 | 0.25 | 50 |
| `fable-5`, `mythos-5` | 10 | 12.50 | 20 | 1.00 | 50 |
| `opus-5`, `opus-4-8`, `opus-4-7`, `opus-4-6`, `opus-4-5` | 5 | 6.25 | 10 | 0.50 | 25 |
| `sonnet-5` | 2 | 2.50 | 4 | 0.20 | 10 |
| `sonnet-4-6`, `sonnet-4-5` | 3 | 3.75 | 6 | 0.30 | 15 |
| `haiku-4-5` | 1 | 1.25 | 2 | 0.10 | 5 |

- **`speed:"fast"`** (Opus 5 / 4.8): input $10, output $50, with the cache multipliers on top (5m ×1.25, 1h ×2, read ×0.1).
- **Web search:** $10 per 1,000 requests.
- **Unknown model:** cost = `null`, displayed as `?`. Never guess.

## 3. Units (founder asked "what about the units?")

Every number is available in three units. A header toggle switches **tokens | API-$ | % of 5h**:

1. **Tokens.** Primary, exact, straight from usage.
2. **API-equivalent $.** List price. A subscription is not billed this; it is the only published way to weigh an
   Opus token against a Sonnet token. Label it "API-equiv".
3. **% of the 5-hour window** — the budget that actually runs out on a subscription. **Quota is NOT API cost**
   (founder, 2026-09-12), and Anthropic doesn't publish the formula, so the meter FITS a proxy to evidence and shows its error.
   - **Evidence already measured (lead, 2026-09-12):** 21 real 5-hour limit hits in the last 30 days, each taken as
     100% at the hit. Leave-one-out error predicting each window from the other 20:

     | proxy | median err | worst |
     |---|---|---|
     | all tokens | 36% | 121% |
     | API-$ | 25% | 104% |
     | **fresh + 5×output** | **18%** | **35%** |
     | API-$ excluding cache reads | 18% | 57% |

     Here fresh = input + cache writes. **Cache reads barely count toward quota; output counts heavily.**
   - **Proxy:** `Q = input + cw5m + cw1h + W_OUT × output`, with `W_OUT = 5` as a named constant. Cache reads are
     excluded. Compute Q per call.
   - **Data points (union):**
     - (a) **Limit-hit windows from transcripts.** An assistant `quotaLimits` with `status:"rejected"` and
       `rateLimitType:"five_hour"`. Window = `resetsAt − 18000 s` → earliest hit ts; value 100%; Q summed over ALL calls in it.
     - (b) **Status-line snapshots.** `statusline.cjs` appends `{ts, session_id, five_hour_pct, five_hour_resets_at,
       seven_day_pct, seven_day_resets_at}` to `limits.jsonl` only when a value changed. Each snapshot is a point
       (Q summed from its window start `resets_at − 18000` → snapshot ts, value = the %).
   - **Fit:** one scale `k` (% per Q) by least squares through the origin over all points. Report leave-one-out
     median and worst absolute error. `node meter.cjs --calibrate` prints the points table, k, and both errors, and
     ALSO the same errors for plain API-$ and all-tokens, so the comparison stays visible as data accrues.
   - **Display:**
     - per call and per turn: `≈0.4% 5h (±18%)`, where the ± is the LIVE leave-one-out median error, never a constant;
     - hide it when there are fewer than 5 points.
   - **Forecast tile:** current % (the latest status-line snapshot, else "unknown") + Q burn over the last 30 min ×
     k → "limit in ≈ 40 min at this pace", or "resets first".
   - **Known blind spot, shown in a tooltip:** usage from claude.ai web or phone on the same account counts toward
     the quota but never appears in these transcripts.

## 4. Normalized records

- **Call:**
  - identity: `{ts, project, sessionId, agentId|null, agentLabel, model, speed, turnId, …}`;
  - tokens: `input, cw5m, cw1h, cr, out, thinking`;
  - derived: `ctx = input+cw5m+cw1h+cr` (what the call re-sent in total), `fresh = input+cw5m+cw1h` (newly added
    this call), `resent = cr` (history re-read from cache);
  - cost: `costUSD, webSearch`;
  - `tools`: names of tool_use blocks in this response;
  - `fedIn`: `[{tool, bytes}]` — the tool_result blocks between this transcript's previous call and this one,
    with each name mapped through a tool_use_id → name table;
  - `injected`: `[{type, bytes}]` — attachments since the previous call.
- **Turn:** `{turnId, ts, promptPreview (first 140 chars, one line), promptChars, source, calls, sums…, durationMs}`.
  `durationMs` comes from `turn_duration` when present.
- **Event:** `{ts, sessionId, kind: "compact"|"limit-hit"|"limit-text", detail}`.

## 5. Engine (`meter.cjs`)

- **Discover:** transcripts, subagents included, modified within `--hours` (default 24). Parse each once.
- **Tail:**
  - Use `fs.watch(~/.claude/projects, {recursive:true})`, plus a 3 s `stat` poll of known files as a fallback.
  - Track a byte offset per file. On growth, read from the offset and carry any trailing partial line to the next read.
  - Pick up new files from watch events, plus a 10 s directory rescan.
- **Aggregates:**
  - per session: totals and context-now (the last call's ctx);
  - across all sessions: burn over the last 60 min (calls, tokens, API-$, est % 5h).
- **Terminal view:** redraw at most twice a second, only on change.
  - Header: 5h % with a reset countdown, 7d %, and burn over the last 60 min.
  - Table of sessions active in the last 2 h.
  - The last 15 calls: `time │ session │ model │ ctx │ fresh │ resent │ out (think) │ API-$ │ %5h │ tools`.

## 6. Dashboard (`--serve`)

Bind **127.0.0.1 only**. Routes:

| Route | Returns |
|---|---|
| `GET /` | `meter.html` |
| `GET /api/state` | `{sessions, calls: latest 500, turns: latest 50 per session, events, limits, calibration}` |
| `GET /api/session/:id` | Every call and turn for that session |
| `GET /events` | SSE messages `{type:"call"\|"turn"\|"event"\|"limits", data}` |

The page, top to bottom:

1. **Header:** stat tiles for 5h and 7d (bar + reset countdown), a burn-rate tile for the last 60 min, and the units toggle.
2. **Live feed:** the newest calls from every session. A new row highlights briefly.
3. **Sessions table** (sortable): label, project, model, calls, context now, total, last 60 min, last active. Click a row for its detail.
4. **Session detail:**
   - (a) a line chart of context size per call, with compaction markers;
   - (b) stacked bars per call, in the current unit: cache read │ 1h write │ 5m write │ uncached input │ thinking │ visible output;
   - (c) turns, newest first, each expandable to per-call rows showing the tools called, the tool results fed in
     (tool + est. tokens) and the injected attachments.
   - Beside each prompt preview, show a legend line: **fresh** = new tokens this call; **re-sent** = history re-read from cache.

**Load the `dataviz` skill with the Skill tool before writing any chart.** Follow it: run the validator on the palette,
design light and dark separately (`prefers-color-scheme`), add hover tooltips and a legend, and provide a table view.

## 7. Status line (`statusline.cjs`)

- **Input:** read the stdin JSON.
- **Output:** print ONE line, for example:
  `Opus 5 │ ctx 244k 24% │ last +1.7k new, 245k cached → 4.4k out (3.2k think) │ $12.40 │ 5h 63% ↻1h12m │ 7d 41%`
- **The "last" segment:** read only the last 256 KB of `transcript_path` and take the last assistant usage.
- **Limits:** append a snapshot to `limits.jsonl` only when the 5h or 7d values changed. Compare against the file's last line.
- **Speed:** under 100 ms. Never throw: on any error, print a short fallback line and exit 0.
- **Settings:** the LEAD adds the entry to `~/.claude/settings.json`, not the builder:
  `"statusLine": {"type": "command", "command": "node ~/.claude/token-meter/statusline.cjs"}`.

## 8. Verification (prove each check can fail — CE-012 / CE-017)

1. **`node meter.cjs --selftest`**, with inline fixtures. Make each assertion fail once before it passes, and say so in the report:
   - 3 lines sharing `message.id` + `requestId` → counted once, with tool names merged;
   - a 1h cache write priced at 2× input, and a 5m write at 1.25×;
   - an unknown model → cost `null`;
   - `fedIn` mapped by tool_use_id;
   - a tool_result user record does NOT start a turn;
   - a partial trailing line is buffered, not dropped.
2. **Reconcile:** for a real, large multi-agent transcript, compare the
   meter's per-model token sums with an independent `python3` sum using the same dedupe. They must be equal.
3. **Live:** start `--serve`, hit `/api/state` with curl, and run `curl -N /events` for 60 s. At least one real call
   from an active session must arrive within 2 s of its line appearing in the transcript.
4. **Status line:**
   - piping a realistic fixture JSON prints the line;
   - garbage stdin prints the fallback with exit 0;
   - a changed fixture appends exactly one `limits.jsonl` line, and an unchanged one appends none.
5. **Look at the page:** headless Chrome (use Playwright's `chrome-headless-shell`, not full Chrome) at 1280px and
   400px, in light and dark. Screenshots go in `~/.claude/token-meter/shots/`.

**Out of scope:** OpenTelemetry; editing any settings file; anything inside a project repo.

---

## 9. Live proxy — Tier 2 (founder-approved 2026-09-12: route EVERY session through it)

**Why.** Transcripts give exact counts only after a response finishes. A local pass-through proxy sees each request
as it happens:
- the exact input and cache tokens at the moment the response STARTS (the SSE `message_start` event);
- output streaming live;
- what is inside each request (system prompt, tool schemas, history, new messages). The transcript never contains this.

**File:** `proxy.cjs`, a separate process from `meter.cjs`. It carries every session's traffic, so keep it minimal,
stable and dependency-free. It listens on 127.0.0.1:4778. **The LEAD installs it (launchd KeepAlive) and sets
`ANTHROPIC_BASE_URL`; the builder never does.**

### 9.1 Forwarding contract

Source: code.claude.com/docs/en/llm-gateway-protocol, verified 2026-09-12. **Breaking any of these breaks every Claude Code session.**

- **Upstream:** `https://api.anthropic.com`, overridable by env `PROXY_UPSTREAM` for tests. Keep the same method, path
  and query. Inference is `POST /v1/messages?beta=true`; Claude Code also calls `/v1/messages/count_tokens`,
  `HEAD /api/hello` and `GET /v1/models`. Pass EVERY path through generically.
- **Request headers:** forward every one unchanged except the hop-by-hop headers (`connection`, `keep-alive`,
  `transfer-encoding`, `upgrade`, `proxy-*`), and set `host: api.anthropic.com`.
  - **Never allowlist.** `anthropic-beta` carries the OAuth capability the subscription login needs; stripping it = 401 on every request.
- **Request body:** forward it byte-for-byte. NEVER re-serialize the JSON: `cache_control` markers and the order of
  `system` blocks must survive untouched. Parse a COPY only.
- **Response:** stream it through immediately, byte-for-byte, with status and headers (minus hop-by-hop). Include
  SSE `ping` events and comment lines — Claude Code aborts a stream that is silent for 300 s. Never buffer. Forward
  error bodies unmodified, because Claude Code's retry logic reads their wording.
- **Encoded responses:** if a response has `content-encoding`, pass the original bytes through and parse a
  decompressed copy (zlib).
- **Upstream unreachable:** respond promptly with 502 and
  `{"type":"error","error":{"type":"api_error","message":"token-meter proxy: <reason>"}}`. Never hang.
- **Connection reuse:** use `https.Agent({keepAlive:true})` to the upstream.
- **⚠ SECURITY:** NEVER write the VALUES of `authorization`, `x-api-key` or `cookie`, or ANY request or response body
  CONTENT, anywhere: not `live.jsonl`, not `proxy.log`, not stdout or stderr. Record only header names, byte sizes,
  token counts, ids, model, timings and error TYPE.

### 9.2 What it records → `~/.claude/token-meter/live.jsonl`

Append-only. At startup, rotate to `live.1.jsonl` if the file is over 50 MB.

- **`req-start`** `{ts, reqId, path, sessionId, agentId, parentAgentId, model, maxTokens, thinking, effort, stream, bodyBytes, breakdown}`
  - `sessionId` / `agentId` / `parentAgentId` come from the `x-claude-code-session-id`, `x-claude-code-agent-id` and
    `x-claude-code-parent-agent-id` headers.
  - `effort` comes from `output_config`.
  - `breakdown` is in BYTES, taken from the parsed copy:
    - system blocks: `[{bytes, cacheControl}]`;
    - tools: `[{name, bytes}]` plus a total;
    - messages: count, bytes per role, and bytes per content-block type — text, image, thinking, `tool_use` by name,
      and `tool_result` by tool name (resolve names through the tool_use ids inside the same request);
    - the position of the LAST `cache_control` marker, so the page can split "cached prefix" from "new tail".
- **`usage-start`**, on SSE `message_start`: `{reqId, msgId, input, cw5m, cw1h, cr, ttfbMs}`. These are EXACT.
  Also emit `breakdownTokensEst`: each part's bytes × (exact input+cw+cr ÷ counted bytes), labelled est.
- **`progress`**, at most every 500 ms while streaming: `{reqId, outEst, blockType}`.
  `outEst` = streamed characters of `text_delta` + `thinking_delta` + `input_json_delta` ÷ 3.5, labelled est.
- **`usage-end`**, on the last `message_delta`, whose usage is cumulative: `{reqId, msgId, output, stopReason, serverToolUse}`.
- **`req-end`** `{reqId, status, durationMs, errorType}`. `errorType` comes from the parsed error JSON's `error.type` only, never its message.
- **Non-streaming responses** (for example `count_tokens`): record status and duration, and `input_tokens` when present.

### 9.3 Meter integration

- **Source:** `meter.cjs` tails `live.jsonl` like a transcript. It joins to transcript calls by `msgId` (exact) and
  attributes to a session/subagent by `sessionId`/`agentId`.
- **Live feed:** a row appears at `req-start`, gets its exact fresh / re-sent counts at `usage-start`, ticks output
  from `progress`, and snaps to the exact output at `usage-end`.
- **Session detail:** a per-call "what was sent" stacked bar in est. tokens:
  system │ tools │ cached history │ new tail (split by block type and by tool result).
- **Terminal view:** in-flight rows tick.
- **Fallback:** if `live.jsonl` is absent, Tier 1 works exactly as before.

### 9.4 `node proxy.cjs --selftest`

Run against a FAKE local upstream only — **no real traffic, no real credentials.** Make each check fail once first (CE-017):

1. **SSE pass-through is byte-identical** (hash), pings and a comment line included. **No buffering:** the fake
   upstream waits 1 s between events, and the client must receive event 1 in under 500 ms.
2. `anthropic-beta`, `anthropic-version`, `authorization` and `x-claude-code-session-id` reach the upstream unchanged; `host` is rewritten.
3. The request body reaches the upstream byte-identical (hash).
4. The records are correct: `req-start` breakdown, `usage-start` exact tokens, `progress`, and `usage-end` cumulative output.
5. A gzip JSON response passes through byte-identical, and its copy is parsed.
6. With the upstream down, a 502 JSON error comes back within 2 s.
7. **Secret sentinel:** send `Authorization: Bearer SENTINEL-AUTH-123` and a message text `SENTINEL-BODY-456`.
   `grep -r` over `~/.claude/token-meter` for both strings must find ZERO matches.

**The builder must NOT:**
- send real traffic through the proxy;
- set `ANTHROPIC_BASE_URL` anywhere;
- install launchd;
- edit settings.
