#!/usr/bin/env node
'use strict';
/*
 * Token Meter engine + CLI.
 * node meter.cjs                       -> terminal live view
 * node meter.cjs --serve [port]        -> dashboard (default 4777), binds 127.0.0.1 only
 * node meter.cjs --json --since <2h|ISO> [--file <path>] [--hours N] -> dump normalized calls as JSONL
 * node meter.cjs --selftest            -> inline fixture tests
 *
 * Zero npm dependencies. See ~/.claude/token-meter/SPEC.md.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('readline');
const { EventEmitter } = require('events');

const HOME = os.homedir();
const PROJECTS_DIR = process.env.TOKEN_METER_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const METER_DIR = path.join(HOME, '.claude', 'token-meter');
const LIVE_FILE = process.env.TOKEN_METER_LIVE_FILE || path.join(METER_DIR, 'live.jsonl');
// Tier 2 (SPEC.md §9): proxy.cjs's live.jsonl gives EXACT per-request detail
// a transcript only reveals after the fact. Populated by processLiveLine();
// buildCall() below joins a transcript call to it by msgId, when present.
// Absent live.jsonl -> this map just stays empty and Tier 1 works unchanged.
const liveByMsgId = new Map();
// The reverse index: buildCall() populates this so a live.jsonl record that
// arrives AFTER its transcript call was already built (the common real-world
// order -- live.jsonl streams in real time, the transcript line lands once
// Claude Code finishes writing it) can still retroactively attach the join,
// instead of only working when live data happens to arrive first.
const callsByMsgId = new Map();
const CALLS_BY_MSGID_MAX = 5000;
// How long to keep a finished (req-end) live.jsonl record around after
// completion, so a transcript line arriving slightly late can still join to
// it, before evicting it from liveCalls/liveByMsgId. Without this, both maps
// grow forever across a multi-day run fed by a live proxy.
const LIVE_DONE_GRACE_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pricing (USD per million tokens). Order matters: most-specific match first.
// ---------------------------------------------------------------------------
const PRICING_TABLE = [
  ['fable-5-1', { input: 10, w5m: 12.50, w1h: 20, read: 0.25, output: 50 }],
  ['mythos-5-1', { input: 10, w5m: 12.50, w1h: 20, read: 0.25, output: 50 }],
  ['fable-5', { input: 10, w5m: 12.50, w1h: 20, read: 1.00, output: 50 }],
  ['mythos-5', { input: 10, w5m: 12.50, w1h: 20, read: 1.00, output: 50 }],
  ['opus-5', { input: 5, w5m: 6.25, w1h: 10, read: 0.50, output: 25 }],
  ['opus-4-8', { input: 5, w5m: 6.25, w1h: 10, read: 0.50, output: 25 }],
  ['opus-4-7', { input: 5, w5m: 6.25, w1h: 10, read: 0.50, output: 25 }],
  ['opus-4-6', { input: 5, w5m: 6.25, w1h: 10, read: 0.50, output: 25 }],
  ['opus-4-5', { input: 5, w5m: 6.25, w1h: 10, read: 0.50, output: 25 }],
  ['sonnet-5', { input: 2, w5m: 2.50, w1h: 4, read: 0.20, output: 10 }],
  ['sonnet-4-6', { input: 3, w5m: 3.75, w1h: 6, read: 0.30, output: 15 }],
  ['sonnet-4-5', { input: 3, w5m: 3.75, w1h: 6, read: 0.30, output: 15 }],
  ['haiku-4-5', { input: 1, w5m: 1.25, w1h: 2, read: 0.10, output: 5 }],
];
const FAST_OPUS_KEYS = new Set(['opus-5', 'opus-4-8']);
const WEB_SEARCH_PER_REQUEST = 10 / 1000; // $10 per 1,000 requests

function priceFor(model, speed) {
  if (!model) return null;
  for (const [key, price] of PRICING_TABLE) {
    if (model.includes(key)) {
      if (speed === 'fast' && FAST_OPUS_KEYS.has(key)) {
        return { input: 10, w5m: 12.5, w1h: 20, read: 1.0, output: 50 };
      }
      return price;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function stripSlugPrefix(slug) {
  const stripped = slug.replace(/^-Users-tj-/, '');
  return stripped || slug;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c.type === 'text') return c.text || '';
        if (c.type === 'image') return '[image]';
        return '';
      })
      .join(' ');
  }
  return '';
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some((c) => c.type === 'tool_result');
}

function byteLen(s) {
  return Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s || ''));
}

function makeTailBuffer() {
  return { partial: '' };
}

// Feeds raw text through a buffer, calling onLine for each *complete* line.
// A trailing partial line is retained in buf.partial for the next call.
function feedChunk(buf, text, onLine) {
  const chunk = buf.partial + text;
  const lines = chunk.split('\n');
  buf.partial = lines.pop();
  for (const line of lines) {
    if (line.trim()) onLine(line);
  }
}

// ---------------------------------------------------------------------------
// Per-file parse context
// ---------------------------------------------------------------------------
function makeCtx(entry) {
  return {
    project: entry.project,
    sessionId: entry.sessionId,
    agentId: entry.agentId,
    agentLabel: entry.agentLabel,
    toolUseIdToName: new Map(),
    pendingFedIn: [],
    pendingInjected: [],
    currentTurn: null,
    lastCall: null,
  };
}

function buildCall(record, toolNames, ctx) {
  const usage = record.message.usage;
  const model = record.message.model;
  const speed = usage.speed || 'standard';
  // cache_creation_input_tokens (the total) is authoritative -- the split's
  // own ephemeral_5m_input_tokens is unreliable (measured: 96/9842 real
  // records report 5m=0 while the total exceeds ephemeral_1h_input_tokens,
  // e.g. total 6903, 1h 5070, split's own 5m 0 -- silently dropping 1833
  // tokens). Trust the split's 1h figure, derive 5m as the remainder so the
  // two always sum to the reported total.
  const cc = usage.cache_creation || null;
  const totalCacheCreation = usage.cache_creation_input_tokens || 0;
  const cw1h = (cc && cc.ephemeral_1h_input_tokens) || 0;
  // Clamped: measured 4/68,618 real records where the split's own 1h figure
  // EXCEEDS the reported total (worst seen: total short by 4,576 tokens vs
  // 1h alone), which would otherwise make cw5m negative and propagate into
  // fresh/ctx/costUSD.
  const cw5m = Math.max(0, totalCacheCreation - cw1h);
  const input = usage.input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  const thinking = (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0;
  const webSearchReq = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;

  const price = priceFor(model, speed);
  let costUSD = null;
  if (price) {
    costUSD =
      (input / 1e6) * price.input +
      (cw5m / 1e6) * price.w5m +
      (cw1h / 1e6) * price.w1h +
      (cr / 1e6) * price.read +
      (out / 1e6) * price.output +
      webSearchReq * WEB_SEARCH_PER_REQUEST;
  }

  const call = {
    key: record.message.id + '|' + record.requestId,
    ts: record.timestamp,
    project: ctx.project,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    agentLabel: ctx.agentLabel,
    model,
    speed,
    turnId: ctx.currentTurn ? ctx.currentTurn.turnId : null,
    input,
    cw5m,
    cw1h,
    cr,
    out,
    thinking,
    ctx: input + cw5m + cw1h + cr,
    fresh: input + cw5m + cw1h,
    resent: cr,
    costUSD,
    webSearch: webSearchReq,
    tools: toolNames.slice(),
    fedIn: ctx.pendingFedIn,
    injected: ctx.pendingInjected,
  };
  ctx.pendingFedIn = [];
  ctx.pendingInjected = [];
  // Tier 2 join: if the proxy saw this exact API response, attach its
  // request-side "what was sent" breakdown (system/tools/cached/new-tail).
  // Registered both ways -- see callsByMsgId above for why.
  const liveMatch = liveByMsgId.get(record.message.id);
  if (liveMatch) call.sentBreakdown = liveMatch.breakdownTokensEst || null;
  callsByMsgId.set(record.message.id, call);
  // Bounded like the other per-process caches (state.events 500, s.turns
  // 300, s.liveCalls 30) -- this map is global and otherwise grows forever
  // across a multi-day run. Map preserves insertion order, so the oldest
  // entry is always first.
  if (callsByMsgId.size > CALLS_BY_MSGID_MAX) {
    callsByMsgId.delete(callsByMsgId.keys().next().value);
  }
  return call;
}

function sumCalls(calls) {
  const s = { input: 0, cw5m: 0, cw1h: 0, cr: 0, out: 0, thinking: 0, ctx: 0, fresh: 0, resent: 0, costUSD: 0, calls: calls.length };
  let unknownCost = false;
  for (const c of calls) {
    s.input += c.input;
    s.cw5m += c.cw5m;
    s.cw1h += c.cw1h;
    s.cr += c.cr;
    s.out += c.out;
    s.thinking += c.thinking;
    s.ctx += c.ctx;
    s.fresh += c.fresh;
    s.resent += c.resent;
    if (c.costUSD == null) unknownCost = true;
    else s.costUSD += c.costUSD;
  }
  if (unknownCost) s.costUSD = null;
  return s;
}

// processLine mutates ctx and calls emit(type, payload) for 'call' | 'turn' | 'event'.
function processLine(line, ctx, emit) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (e) {
    return; // malformed line, skip
  }
  const type = record.type;

  if (type === 'assistant' && record.message) {
    // quotaLimits can ride on a synthetic (rejected) assistant message too --
    // check it independent of the real-call branch below, or every limit-hit
    // on a rejected call is silently missed.
    const q = record.quotaLimits || record.message.quotaLimits;
    if (q) emit('event', { ts: record.timestamp, sessionId: ctx.sessionId, kind: 'limit-hit', detail: q });
  }

  if (type === 'assistant' && record.message && record.message.usage && record.message.model !== '<synthetic>') {
    const blocks = record.message.content || [];
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    for (const tu of toolUses) ctx.toolUseIdToName.set(tu.id, tu.name);
    const toolNames = toolUses.map((b) => b.name);
    const key = record.message.id + '|' + record.requestId;

    if (ctx.lastCall && ctx.lastCall.key === key) {
      for (const n of toolNames) {
        if (!ctx.lastCall.tools.includes(n)) ctx.lastCall.tools.push(n);
      }
    } else {
      const call = buildCall(record, toolNames, ctx);
      if (ctx.currentTurn) ctx.currentTurn.calls.push(call);
      ctx.lastCall = call;
      emit('call', call);
    }
    return;
  }

  if (type === 'assistant' && record.message && record.message.model === '<synthetic>') {
    const text = extractText(record.message.content);
    if (/limit|resets/i.test(text)) {
      emit('event', { ts: record.timestamp, sessionId: ctx.sessionId, kind: 'limit-text', detail: text.slice(0, 300) });
    }
    return;
  }

  if (type === 'user') {
    const content = record.message && record.message.content;
    if (record.isMeta === true) return; // internal hook stub, not a prompt/tool_result
    // Founder ruling: a session whose last record is a user prompt or a
    // tool_result with no assistant usage after it has a call IN FLIGHT.
    // Mark activity for BOTH shapes; getOrCreateSession clears it on the
    // next real call (see makeEmit's 'call' handling).
    emit('user-activity', { ts: record.timestamp });
    if (hasToolResult(content)) {
      for (const c of content.filter((b) => b.type === 'tool_result')) {
        const name = ctx.toolUseIdToName.get(c.tool_use_id) || 'unknown';
        ctx.pendingFedIn.push({ tool: name, bytes: byteLen(c.content) });
      }
      return;
    }
    // Turn start.
    if (ctx.currentTurn) {
      ctx.currentTurn.sums = sumCalls(ctx.currentTurn.calls);
      emit('turn', ctx.currentTurn);
    }
    const text = extractText(content);
    ctx.currentTurn = {
      turnId: record.uuid || ctx.sessionId + ':' + record.timestamp,
      ts: record.timestamp,
      promptPreview: text.slice(0, 140).replace(/\s+/g, ' '),
      promptChars: text.length,
      source: record.promptSource || (record.message && record.message.promptSource) || null,
      calls: [],
      durationMs: null,
    };
    return;
  }

  if (type === 'attachment') {
    const a = record.attachment || {};
    ctx.pendingInjected.push({ type: a.type, bytes: byteLen(line) });
    return;
  }

  if (type === 'system') {
    if (record.subtype === 'compact_boundary') {
      emit('event', { ts: record.timestamp, sessionId: ctx.sessionId, kind: 'compact', detail: record.compactMetadata });
    } else if (record.subtype === 'turn_duration') {
      if (ctx.currentTurn) {
        ctx.currentTurn.durationMs = record.durationMs;
      }
    }
    return;
  }

  if (type === 'agent-name') {
    ctx.agentLabel = record.agentName;
    return;
  }
}

function finalizeCtx(ctx, emit) {
  if (ctx.currentTurn) {
    ctx.currentTurn.sums = sumCalls(ctx.currentTurn.calls);
    emit('turn', ctx.currentTurn);
    ctx.currentTurn = null;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function makeEntry(fullPath, projectSlug, isSubagent) {
  if (isSubagent) {
    const parts = fullPath.split(path.sep);
    const idx = parts.lastIndexOf('subagents');
    const sessionId = parts[idx - 1];
    const base = parts[idx + 1];
    const agentId = base.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const metaPath = path.join(path.dirname(fullPath), `agent-${agentId}.meta.json`);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      /* no meta */
    }
    return {
      path: fullPath,
      project: stripSlugPrefix(projectSlug),
      sessionId,
      agentId,
      agentLabel: meta.description || meta.agentType || agentId,
    };
  }
  const sessionId = path.basename(fullPath, '.jsonl');
  return { path: fullPath, project: stripSlugPrefix(projectSlug), sessionId, agentId: null, agentLabel: null };
}

function discoverFiles({ hours = 24, file = null } = {}) {
  if (file) {
    const abs = path.resolve(file);
    const parts = abs.split(path.sep);
    const isSubagent = parts.includes('subagents');
    const projIdx = parts.indexOf('projects');
    const projectSlug = projIdx >= 0 ? parts[projIdx + 1] : 'unknown';
    return [makeEntry(abs, projectSlug, isSubagent)];
  }
  const cutoff = Date.now() - hours * 3600 * 1000;
  const out = [];
  let projDirs = [];
  try {
    projDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const pd of projDirs) {
    if (!pd.isDirectory()) continue;
    const pPath = path.join(PROJECTS_DIR, pd.name);
    let entries = [];
    try {
      entries = fs.readdirSync(pPath, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(pPath, e.name);
      if (e.isDirectory()) {
        const subDir = path.join(full, 'subagents');
        let subFiles = [];
        try {
          subFiles = fs.readdirSync(subDir);
        } catch (err) {
          continue;
        }
        for (const f of subFiles) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(subDir, f);
          let st;
          try {
            st = fs.statSync(fp);
          } catch (err) {
            continue;
          }
          if (st.mtimeMs >= cutoff) out.push(makeEntry(fp, pd.name, true));
        }
        continue;
      }
      if (e.name.endsWith('.jsonl')) {
        let st;
        try {
          st = fs.statSync(full);
        } catch (err) {
          continue;
        }
        if (st.mtimeMs >= cutoff) out.push(makeEntry(full, pd.name, false));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Global aggregator state (used by terminal view + dashboard)
// ---------------------------------------------------------------------------
const bus = new EventEmitter();
bus.setMaxListeners(100);

const state = {
  sessionsMap: new Map(), // key -> {key, sessionId, agentId, project, agentLabel, model, calls:[], turns:[]}
  events: [],
  dirty: false,
};

function sessionKeyFor(entry) {
  return entry.agentId ? `${entry.sessionId}:${entry.agentId}` : entry.sessionId;
}

function getOrCreateSession(entry) {
  const key = sessionKeyFor(entry);
  let s = state.sessionsMap.get(key);
  if (!s) {
    s = {
      key,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      project: entry.project,
      agentLabel: entry.agentLabel,
      model: null,
      calls: [],
      turns: [],
      lastUserTs: null,
      lastCallTs: null,
      transcriptPath: entry.path || null,
    };
    state.sessionsMap.set(key, s);
  } else if (entry.path) {
    s.transcriptPath = entry.path; // keep current in case discovery re-resolves it
  }
  return s;
}

function makeEmit(entry) {
  const s = getOrCreateSession(entry);
  return function emit(kind, payload) {
    if (kind === 'call') {
      s.model = payload.model;
      s.calls.push(payload);
      s.lastCallTs = payload.ts;
      state.dirty = true;
      bus.emit('sse', { type: 'call', data: payload });
    } else if (kind === 'user-activity') {
      s.lastUserTs = payload.ts;
      state.dirty = true;
      bus.emit('sse', { type: 'inflight', data: { key: s.key, ts: payload.ts } });
    } else if (kind === 'turn') {
      s.turns.push(payload);
      if (s.turns.length > 300) s.turns.shift();
      state.dirty = true;
      bus.emit('sse', { type: 'turn', data: payload });
    } else if (kind === 'event') {
      const ev = { ts: payload.ts, sessionId: payload.sessionId, kind: payload.kind, detail: payload.detail };
      state.events.push(ev);
      if (state.events.length > 500) state.events.shift();
      state.dirty = true;
      bus.emit('sse', { type: 'event', data: ev });
    }
  };
}

function parseFileFull(entry) {
  return new Promise((resolve) => {
    const ctx = makeCtx(entry);
    const emit = makeEmit(entry);
    let rl;
    try {
      rl = readline.createInterface({ input: fs.createReadStream(entry.path, { encoding: 'utf8' }) });
    } catch (e) {
      resolve();
      return;
    }
    rl.on('line', (line) => {
      if (line.trim()) processLine(line, ctx, emit);
    });
    rl.on('close', () => {
      finalizeCtx(ctx, emit);
      let size = 0;
      try {
        size = fs.statSync(entry.path).size;
      } catch (e) {
        /* file may have been rotated */
      }
      entry.ctx = ctx;
      entry.offset = size;
      entry.tailBuf = makeTailBuffer();
      resolve();
    });
    rl.on('error', () => resolve());
  });
}

function readGrowth(entry) {
  let st;
  try {
    st = fs.statSync(entry.path);
  } catch (e) {
    return;
  }
  if (st.size <= entry.offset) {
    entry.offset = Math.min(entry.offset, st.size);
    return;
  }
  const len = st.size - entry.offset;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(entry.path, 'r');
    fs.readSync(fd, buf, 0, len, entry.offset);
  } catch (e) {
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  entry.offset = st.size;
  const emit = makeEmit(entry);
  feedChunk(entry.tailBuf, buf.toString('utf8'), (line) => processLine(line, entry.ctx, emit));
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------
// A call is IN FLIGHT when the last thing seen in the transcript is a user
// prompt or a tool_result and no assistant usage line has landed since.
const IN_FLIGHT_MAX_AGE_MS = 10 * 60 * 1000; // a genuinely in-flight call resolves in minutes, not hours

// A session reads as "in flight" only while it's plausibly ACTUALLY in
// flight right now: the pending user/tool_result record is recent AND the
// transcript file itself was touched recently. Without both checks, a
// session abandoned mid-turn hours ago (crashed, rate-limited, closed)
// reads as in-flight forever -- lead caught 8 such sessions stuck since
// 03:45Z.
function inFlightSince(s) {
  if (!s.lastUserTs) return null;
  const pending = !s.lastCallTs || new Date(s.lastUserTs).getTime() > new Date(s.lastCallTs).getTime();
  if (!pending) return null;
  const now = Date.now();
  if (now - new Date(s.lastUserTs).getTime() > IN_FLIGHT_MAX_AGE_MS) return null;
  if (!s.transcriptPath) return null;
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(s.transcriptPath).mtimeMs;
  } catch (e) {
    return null; // file gone -- can't be in flight
  }
  if (now - mtimeMs > IN_FLIGHT_MAX_AGE_MS) return null;
  return s.lastUserTs;
}

function sessionSummary(s) {
  const now = Date.now();
  const hourAgo = now - 3600 * 1000;
  const total = sumCalls(s.calls);
  const lastHour = sumCalls(s.calls.filter((c) => new Date(c.ts).getTime() >= hourAgo));
  const last = s.calls[s.calls.length - 1];
  return {
    key: s.key,
    sessionId: s.sessionId,
    agentId: s.agentId,
    project: s.project,
    agentLabel: s.agentLabel,
    model: s.model,
    calls: s.calls.length,
    ctxNow: last ? last.ctx : 0,
    total,
    lastHour,
    lastActive: last ? last.ts : null,
    inFlightSince: inFlightSince(s),
  };
}

function allCallsSorted(limit) {
  const all = [];
  for (const s of state.sessionsMap.values()) all.push(...s.calls);
  all.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return limit ? all.slice(-limit) : all;
}

// ---------------------------------------------------------------------------
// Tier 2: live.jsonl (proxy.cjs) tailing -- req-start/usage-start/progress/
// usage-end/req-end records, one per in-progress or finished API call, with
// EXACT tokens the instant a response starts (not just after it finishes).
// Fallback: if the file never exists, every function below is a no-op and
// Tier 1 (transcript-only) works exactly as before.
// ---------------------------------------------------------------------------
function processLiveLine(line, liveEmit) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    return;
  }
  const { type, reqId } = rec;
  if (!reqId) return;
  let lc = liveCalls.get(reqId);
  if (type === 'req-start') {
    lc = {
      reqId,
      ts: rec.ts,
      path: rec.path,
      sessionId: rec.sessionId,
      agentId: rec.agentId,
      parentAgentId: rec.parentAgentId,
      model: rec.model,
      maxTokens: rec.maxTokens,
      thinking: rec.thinking,
      effort: rec.effort,
      stream: rec.stream,
      bodyBytes: rec.bodyBytes,
      breakdown: rec.breakdown,
      status: 'pending',
      msgId: null,
      input: null,
      cw5m: null,
      cw1h: null,
      cr: null,
      ttfbMs: null,
      breakdownTokensEst: null,
      outEst: 0,
      output: null,
      stopReason: null,
      httpStatus: null,
      durationMs: null,
      errorType: null,
    };
    liveCalls.set(reqId, lc);
  } else if (lc && type === 'usage-start') {
    Object.assign(lc, {
      msgId: rec.msgId,
      input: rec.input,
      cw5m: rec.cw5m,
      cw1h: rec.cw1h,
      cr: rec.cr,
      ttfbMs: rec.ttfbMs,
      breakdownTokensEst: rec.breakdownTokensEst || null,
      status: 'streaming',
    });
    liveByMsgId.set(rec.msgId, lc);
    const existingCall = callsByMsgId.get(rec.msgId);
    if (existingCall) existingCall.sentBreakdown = lc.breakdownTokensEst || null;
  } else if (lc && type === 'progress') {
    lc.outEst = rec.outEst;
  } else if (lc && type === 'usage-end') {
    Object.assign(lc, { output: rec.output, stopReason: rec.stopReason, serverToolUse: rec.serverToolUse });
  } else if (lc && type === 'req-end') {
    Object.assign(lc, { status: 'done', httpStatus: rec.status, durationMs: rec.durationMs, errorType: rec.errorType });
    if (rec.inputTokens != null) lc.inputTokens = rec.inputTokens;
    // Evict after a grace window rather than immediately -- the transcript
    // join (buildCall's liveByMsgId lookup) may not have landed yet.
    const doneReqId = reqId;
    const doneMsgId = lc.msgId;
    setTimeout(() => {
      liveCalls.delete(doneReqId);
      if (doneMsgId) liveByMsgId.delete(doneMsgId);
    }, LIVE_DONE_GRACE_MS).unref();
  } else {
    return; // unmatched reqId (e.g. proxy restarted mid-stream) -- ignore
  }
  attachLiveToSession(lc);
  liveEmit(lc);
}

function attachLiveToSession(lc) {
  if (!lc.sessionId) return;
  const s = getOrCreateSession({ sessionId: lc.sessionId, agentId: lc.agentId, project: null, agentLabel: null });
  if (!s.liveCalls) s.liveCalls = new Map();
  s.liveCalls.set(lc.reqId, lc);
  if (s.liveCalls.size > 30) {
    s.liveCalls.delete(s.liveCalls.keys().next().value);
  }
}

async function startLiveTailer() {
  const liveEntry = { offset: 0, tailBuf: makeTailBuffer() };
  const emit = (lc) => {
    state.dirty = true;
    bus.emit('sse', { type: 'live', data: lc });
  };

  await new Promise((resolve) => {
    let rl;
    try {
      rl = readline.createInterface({ input: fs.createReadStream(LIVE_FILE, { encoding: 'utf8' }) });
    } catch (e) {
      resolve();
      return;
    }
    rl.on('line', (line) => {
      if (line.trim()) processLiveLine(line, emit);
    });
    rl.on('close', () => {
      try {
        liveEntry.offset = fs.statSync(LIVE_FILE).size;
      } catch (e) {
        /* file absent -- fine, Tier 1 fallback */
      }
      resolve();
    });
    rl.on('error', () => resolve());
  });

  function poll() {
    let st;
    try {
      st = fs.statSync(LIVE_FILE);
    } catch (e) {
      return; // file absent -- no-op, Tier 1 works unchanged
    }
    if (st.size <= liveEntry.offset) {
      liveEntry.offset = Math.min(liveEntry.offset, st.size);
      return;
    }
    const len = st.size - liveEntry.offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(LIVE_FILE, 'r');
      fs.readSync(fd, buf, 0, len, liveEntry.offset);
    } catch (e) {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    liveEntry.offset = st.size;
    feedChunk(liveEntry.tailBuf, buf.toString('utf8'), (line) => processLiveLine(line, emit));
  }
  setInterval(poll, 1000); // finer-grained than the transcript's 3s poll -- live rows should visibly tick

  try {
    fs.watch(path.dirname(LIVE_FILE), (eventType, filename) => {
      if (filename === path.basename(LIVE_FILE)) poll();
    });
  } catch (e) {
    // poll fallback covers it
  }
}

// ---------------------------------------------------------------------------
// Tailing (fs.watch + poll fallback)
// ---------------------------------------------------------------------------
let entries = []; // active discovered file entries with ctx/offset attached
const liveCalls = new Map(); // reqId -> live call snapshot (Tier 2, see above)

async function startTailer(hoursOpt) {
  entries = discoverFiles({ hours: hoursOpt });
  // Parse live.jsonl BEFORE transcripts: it's the earlier-arriving side of
  // the msgId join in real operation (the proxy sees a response streaming in
  // real time; the transcript line lands once Claude Code finishes writing
  // it), so this ordering makes the forward join work on more calls at
  // startup. The reverse (callsByMsgId) join in buildCall/processLiveLine
  // covers the rest regardless of ordering.
  await startLiveTailer();
  await Promise.all(entries.map(parseFileFull));

  function pollGrowth() {
    for (const e of entries) readGrowth(e);
  }
  setInterval(pollGrowth, 3000);

  async function rescan() {
    const fresh = discoverFiles({ hours: hoursOpt });
    const known = new Set(entries.map((e) => e.path));
    const added = fresh.filter((e) => !known.has(e.path));
    for (const e of added) {
      await parseFileFull(e);
      entries.push(e);
    }
  }
  setInterval(rescan, 10000); // fallback only -- registerIfNew below is the fast path

  // A brand-new session's file doesn't exist in `entries` yet, so pollGrowth
  // (which only iterates known entries) can't see it; without this it sat
  // unregistered until the 10s rescan, an 8s+ live-feed lag on a fresh
  // session. Register it the instant fs.watch reports it.
  const pendingRegistration = new Set();
  async function registerIfNew(fullPath) {
    if (entries.some((e) => e.path === fullPath) || pendingRegistration.has(fullPath)) return;
    pendingRegistration.add(fullPath);
    try {
      const rel = path.relative(PROJECTS_DIR, fullPath);
      const parts = rel.split(path.sep);
      if (parts.length < 2) return;
      const projectSlug = parts[0];
      const isSubagent = parts.includes('subagents');
      let entry;
      try {
        entry = makeEntry(fullPath, projectSlug, isSubagent);
      } catch (e) {
        return;
      }
      await parseFileFull(entry);
      if (!entries.some((e) => e.path === fullPath)) entries.push(entry);
    } finally {
      pendingRegistration.delete(fullPath);
    }
  }

  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        const fullPath = path.join(PROJECTS_DIR, filename);
        if (!entries.some((e) => e.path === fullPath)) registerIfNew(fullPath);
      }
      pollGrowth();
    });
  } catch (e) {
    // recursive watch unsupported on this platform; poll fallback covers it
  }
}

// ---------------------------------------------------------------------------
// Terminal view
// ---------------------------------------------------------------------------
function fmtK(n) {
  if (n == null) return '?';
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtUSD(n) {
  return n == null ? '?' : '$' + n.toFixed(2);
}
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function computeHeaderStats(allCalls, sessions) {
  const now = Date.now();
  const min5Ago = now - 5 * 60 * 1000;
  const hourAgo = now - 3600 * 1000;
  const last60 = allCalls.filter((c) => new Date(c.ts).getTime() >= hourAgo);
  const tokensLast60 = sumCalls(last60);
  const last5 = last60.filter((c) => new Date(c.ts).getTime() >= min5Ago);
  const tokensLast5 = last5.reduce((a, c) => a + c.fresh + c.resent + c.out, 0);
  const ratePerMin = tokensLast5 / 5;
  let biggest = null;
  for (const c of last60) {
    const total = c.fresh + c.resent + c.out;
    if (!biggest || total > biggest._total) biggest = Object.assign({ _total: total }, c);
  }
  const activeNow = sessions.filter((s) => s.inFlightSince || (s.lastActive && new Date(s.lastActive).getTime() >= min5Ago)).length;
  return { tokensLast60, ratePerMin, biggest, activeNow };
}

function fmtElapsed(sinceISO) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(sinceISO).getTime()) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
}

// Tier 2: a ticking status line for a session's most recent in-progress live
// call (proxy.cjs), e.g. "streaming 1.2k out (3.4s)". null when there's no
// live data for this session (Tier 1 fallback -- caller falls back to the
// plain elapsed-time in-flight badge).
function liveTickText(sessionKey) {
  const s = state.sessionsMap.get(sessionKey);
  if (!s || !s.liveCalls || !s.liveCalls.size) return null;
  let latest = null;
  for (const lc of s.liveCalls.values()) {
    if (lc.status === 'done') continue;
    if (!latest || lc.ts > latest.ts) latest = lc;
  }
  if (!latest) return null;
  const secs = ((Date.now() - new Date(latest.ts).getTime()) / 1000).toFixed(1);
  if (latest.status === 'pending') return `⏳ waiting for first byte (${secs}s)`;
  return `⏳ streaming ${fmtK(latest.outEst)} out~ (${secs}s)`;
}

function renderTerminal() {
  const lines = [];
  const now = Date.now();
  const twoHoursAgo = now - 2 * 3600 * 1000;

  const allCalls = allCallsSorted();
  const sessions = [...state.sessionsMap.values()].map(sessionSummary);
  const stats = computeHeaderStats(allCalls, sessions);

  lines.push(
    `Token Meter -- last 60m: ${fmtK(stats.tokensLast60.fresh)} fresh / ${fmtK(stats.tokensLast60.resent)} resent / ${fmtK(stats.tokensLast60.out)} out` +
      `  |  rate(5m): ${fmtK(stats.ratePerMin)} tok/min` +
      `  |  biggest(60m): ${stats.biggest ? fmtK(stats.biggest._total) + ' (' + stats.biggest.model.replace('claude-', '') + ')' : '-'}` +
      `  |  active now: ${stats.activeNow}`
  );
  lines.push('');
  lines.push(pad('SESSION', 40) + pad('MODEL', 14) + pad('CALLS', 7) + pad('CTX NOW', 10) + pad('TOTAL $', 10) + pad('LAST ACTIVE', 12) + 'STATUS');
  const activeSessions = sessions
    .filter((s) => (s.lastActive && new Date(s.lastActive).getTime() >= twoHoursAgo) || s.inFlightSince)
    .sort((a, b) => new Date(b.lastActive || b.inFlightSince) - new Date(a.lastActive || a.inFlightSince));
  for (const s of activeSessions) {
    const label = (s.agentId ? `${s.project}/${s.agentLabel}` : `${s.project}/${s.sessionId.slice(0, 8)}`).slice(0, 39);
    const status = liveTickText(s.key) || (s.inFlightSince ? `⏳ in flight ${fmtElapsed(s.inFlightSince)}` : '');
    const lastActiveShort = s.lastActive ? new Date(s.lastActive).toISOString().slice(11, 19) : '-';
    lines.push(pad(label, 40) + pad(s.model || '?', 14) + pad(s.calls, 7) + pad(fmtK(s.ctxNow), 10) + pad(fmtUSD(s.total.costUSD), 10) + pad(lastActiveShort, 12) + status);
  }
  lines.push('');
  lines.push('LAST 15 CALLS');
  lines.push(pad('TIME', 10) + pad('SESSION', 24) + pad('MODEL', 12) + pad('CTX', 8) + pad('FRESH', 8) + pad('RESENT', 8) + pad('OUT(THINK)', 12) + pad('API-$', 8) + 'TOOLS');
  const last15 = allCalls.slice(-15).reverse();
  for (const c of last15) {
    const t = new Date(c.ts).toISOString().slice(11, 19);
    lines.push(
      pad(t, 10) +
        pad(c.sessionId.slice(0, 23), 24) +
        pad(c.model.replace('claude-', ''), 12) +
        pad(fmtK(c.ctx), 8) +
        pad(fmtK(c.fresh), 8) +
        pad(fmtK(c.resent), 8) +
        pad(`${fmtK(c.out)}(${fmtK(c.thinking)})`, 12) +
        pad(fmtUSD(c.costUSD), 8) +
        c.tools.join(',')
    );
  }
  return lines.join('\n');
}

function runTerminalView(hours) {
  startTailer(hours);
  let lastRender = '';
  setInterval(() => {
    if (!state.dirty) return;
    state.dirty = false;
    const out = renderTerminal();
    if (out !== lastRender) {
      lastRender = out;
      process.stdout.write('\x1Bc' + out + '\n');
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// Dashboard server
// ---------------------------------------------------------------------------
function startServer(port, hours) {
  startTailer(hours);
  const htmlPath = path.join(__dirname, 'meter.html');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(htmlPath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('meter.html not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/api/state') {
      const sessions = [...state.sessionsMap.values()].map(sessionSummary);
      const calls = allCallsSorted(500);
      const turns = [];
      for (const s of state.sessionsMap.values()) turns.push(...s.turns.slice(-50));
      const live = [...liveCalls.values()].filter((lc) => lc.status !== 'done');
      const body = JSON.stringify({
        sessions,
        calls,
        turns,
        events: state.events.slice(-200),
        live,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
      const s = state.sessionsMap.get(id);
      if (!s) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const live = s.liveCalls ? [...s.liveCalls.values()] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: sessionSummary(s), calls: s.calls, turns: s.turns, live }));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const onEvent = (msg) => {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      };
      bus.on('sse', onEvent);
      req.on('close', () => bus.off('sse', onEvent));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`token-meter dashboard: port ${port} is already in use (another dashboard instance?). Exiting.`);
    else console.error(`token-meter dashboard: listen failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.error(`token-meter dashboard: http://127.0.0.1:${port}`);
  });
  return server;
}

// ---------------------------------------------------------------------------
// --json dump mode
// ---------------------------------------------------------------------------
function parseSince(s) {
  if (!s) return 0;
  const m = /^(\d+)h$/.exec(s);
  if (m) return Date.now() - Number(m[1]) * 3600 * 1000;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getTime();
  return 0;
}

async function runJsonDump(opts) {
  const list = discoverFiles({ hours: opts.file ? undefined : opts.hours || 168, file: opts.file });
  const sinceMs = parseSince(opts.since);
  const out = [];
  for (const entry of list) {
    const ctx = makeCtx(entry);
    const localCalls = [];
    const emit = (kind, payload) => {
      if (kind === 'call') localCalls.push(payload);
    };
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: fs.createReadStream(entry.path, { encoding: 'utf8' }) });
      rl.on('line', (line) => {
        if (line.trim()) processLine(line, ctx, emit);
      });
      rl.on('close', resolve);
      rl.on('error', resolve);
    });
    out.push(...localCalls);
  }
  for (const c of out) {
    if (new Date(c.ts).getTime() >= sinceMs) process.stdout.write(JSON.stringify(c) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

function runSelftest() {
  let failures = 0;
  function test(name, fn) {
    try {
      fn();
      console.log('ok   -', name);
    } catch (e) {
      failures++;
      console.log('FAIL -', name, '--', e.message);
    }
  }

  // 1. Three lines sharing message.id+requestId counted once, tool names merged.
  test('dedupe by message.id+requestId, tools merged', () => {
    const entry = { project: 'p', sessionId: 's1', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const calls = [];
    const emit = (kind, payload) => {
      if (kind === 'call') calls.push(payload);
    };
    const turnLine = JSON.stringify({ type: 'user', isMeta: false, uuid: 't1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5, output_tokens_details: { thinking_tokens: 2 }, speed: 'standard' };
    const l1 = JSON.stringify({ type: 'assistant', requestId: 'req1', timestamp: '2026-01-01T00:00:01Z', message: { id: 'msg1', model: 'claude-sonnet-5', usage, content: [{ type: 'thinking', thinking: 'x' }] } });
    const l2 = JSON.stringify({ type: 'assistant', requestId: 'req1', timestamp: '2026-01-01T00:00:01Z', message: { id: 'msg1', model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } });
    const l3 = JSON.stringify({ type: 'assistant', requestId: 'req1', timestamp: '2026-01-01T00:00:01Z', message: { id: 'msg1', model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'done' }] } });
    processLine(turnLine, ctx, emit);
    processLine(l1, ctx, emit);
    processLine(l2, ctx, emit);
    processLine(l3, ctx, emit);
    assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
    assert(calls[0].tools.includes('Bash'), 'tool name Bash should be merged from the second line');
  });

  // 2. 1h cache write priced at 2x input, 5m write at 1.25x (sonnet-5: input=2, w1h=4, w5m=2.5).
  test('cache write pricing multipliers (1h=2x, 5m=1.25x of input)', () => {
    const entry = { project: 'p', sessionId: 's2', agentId: null, agentLabel: null };
    const ctx1h = makeCtx(entry);
    const calls1h = [];
    const usage1h = { input_tokens: 0, cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 1000000, ephemeral_5m_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: 0, speed: 'standard' };
    processLine(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: 't', message: { id: 'm1', model: 'claude-sonnet-5', usage: usage1h, content: [] } }), ctx1h, (k, p) => k === 'call' && calls1h.push(p));
    assert(Math.abs(calls1h[0].costUSD - 4) < 1e-9, `1h write of 1e6 tokens should cost $4 (2x input $2), got ${calls1h[0].costUSD}`);

    const ctx5m = makeCtx(entry);
    const calls5m = [];
    const usage5m = { input_tokens: 0, cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1000000 }, cache_read_input_tokens: 0, output_tokens: 0, speed: 'standard' };
    processLine(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: 't', message: { id: 'm2', model: 'claude-sonnet-5', usage: usage5m, content: [] } }), ctx5m, (k, p) => k === 'call' && calls5m.push(p));
    assert(Math.abs(calls5m[0].costUSD - 2.5) < 1e-9, `5m write of 1e6 tokens should cost $2.50 (1.25x input $2), got ${calls5m[0].costUSD}`);
  });

  // 3. Unknown model -> cost null.
  test('unknown model -> costUSD null', () => {
    const entry = { project: 'p', sessionId: 's3', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const calls = [];
    const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10, speed: 'standard' };
    processLine(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: 't', message: { id: 'm3', model: 'claude-mystery-9', usage, content: [] } }), ctx, (k, p) => k === 'call' && calls.push(p));
    assert(calls[0].costUSD === null, `expected costUSD null for unknown model, got ${calls[0].costUSD}`);
  });

  // 4. fedIn mapped by tool_use_id.
  test('fedIn mapped by tool_use_id', () => {
    const entry = { project: 'p', sessionId: 's4', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const calls = [];
    const emit = (k, p) => k === 'call' && calls.push(p);
    const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, speed: 'standard' };
    processLine(JSON.stringify({ type: 'assistant', requestId: 'ra', timestamp: 't1', message: { id: 'ma', model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] } }), ctx, emit);
    processLine(JSON.stringify({ type: 'user', isMeta: false, timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents here' }] } }), ctx, emit);
    processLine(JSON.stringify({ type: 'assistant', requestId: 'rb', timestamp: 't3', message: { id: 'mb', model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'ok' }] } }), ctx, emit);
    assert(calls.length === 2, `expected 2 calls, got ${calls.length}`);
    assert(calls[1].fedIn.length === 1 && calls[1].fedIn[0].tool === 'Read', `expected fedIn=[{tool:Read}], got ${JSON.stringify(calls[1].fedIn)}`);
  });

  // 5. A tool_result user record does NOT start a turn.
  test('tool_result user record does not start a turn', () => {
    const entry = { project: 'p', sessionId: 's5', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const emit = () => {};
    processLine(JSON.stringify({ type: 'user', isMeta: false, uuid: 'turnA', timestamp: 't1', message: { role: 'user', content: 'hello' } }), ctx, emit);
    const turnIdBefore = ctx.currentTurn.turnId;
    processLine(JSON.stringify({ type: 'user', isMeta: false, timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] } }), ctx, emit);
    assert(ctx.currentTurn.turnId === turnIdBefore, 'tool_result record must not replace currentTurn');
  });

  // 6. A partial trailing line is buffered, not dropped.
  test('partial trailing line buffered not dropped', () => {
    const buf = makeTailBuffer();
    const seen = [];
    feedChunk(buf, 'line1\nline2\npart', (l) => seen.push(l));
    assert(seen.join(',') === 'line1,line2', `expected line1,line2 got ${seen.join(',')}`);
    assert(buf.partial === 'part', `expected partial buffer "part", got "${buf.partial}"`);
    feedChunk(buf, 'ial\nline3\n', (l) => seen.push(l));
    assert(seen.join(',') === 'line1,line2,partial,line3', `expected reconstructed "partial" line, got ${seen.join(',')}`);
  });

  // 7. A quotaLimits rejection riding on a SYNTHETIC assistant message still
  //    emits a limit-hit event (bug found live: real transcripts carry
  //    quotaLimits on a <synthetic> rejected message, not a real usage one).
  test('quotaLimits on a synthetic assistant message still emits limit-hit', () => {
    const entry = { project: 'p', sessionId: 's7', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const events = [];
    const emit = (kind, payload) => {
      if (kind === 'event') events.push(payload);
    };
    const rec = {
      type: 'assistant',
      timestamp: 't1',
      quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1234567890 },
      message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: "you've hit your limit" }] },
    };
    processLine(JSON.stringify(rec), ctx, emit);
    assert(events.some((e) => e.kind === 'limit-hit'), `expected a limit-hit event, got ${JSON.stringify(events)}`);
  });

  console.log('');
  // 8. In-flight detection: a session whose last record is a user prompt (or
  //    tool_result) with no assistant usage after it is "in flight"; it
  //    clears the instant a real call lands.
  test('in-flight: user record with no call after it, then clears on call', () => {
    const tmpFile = require('os').tmpdir() + '/token-meter-selftest-inflight.jsonl';
    fs.writeFileSync(tmpFile, ''); // fresh mtime = now
    const s = { lastUserTs: null, lastCallTs: null, transcriptPath: tmpFile };
    s.lastUserTs = new Date().toISOString();
    assert(inFlightSince(s) === s.lastUserTs, `expected in-flight after a lone RECENT user record, got ${inFlightSince(s)}`);
    s.lastCallTs = new Date(Date.now() + 1000).toISOString(); // a real call lands after the prompt
    assert(inFlightSince(s) === null, `expected in-flight to clear once a call lands after it, got ${inFlightSince(s)}`);
    fs.unlinkSync(tmpFile);
  });

  // 8b. A pending record from HOURS ago must not read as in-flight forever,
  // even with no later call -- the exact bug the lead caught (8 sessions
  // stuck "in flight" since 03:45Z).
  test('in-flight: a stale pending record (hours old) is NOT in flight', () => {
    const tmpFile = require('os').tmpdir() + '/token-meter-selftest-inflight-stale.jsonl';
    fs.writeFileSync(tmpFile, '');
    const staleTs = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); // 3 hours ago
    fs.utimesSync(tmpFile, new Date(staleTs), new Date(staleTs)); // transcript ALSO untouched since then
    const s = { lastUserTs: staleTs, lastCallTs: null, transcriptPath: tmpFile };
    assert(inFlightSince(s) === null, `expected a 3-hour-old pending record to NOT read as in-flight, got ${inFlightSince(s)}`);
    fs.unlinkSync(tmpFile);
  });

  // 9. cw5m recovery when the split disagrees with the reported total (real
  //    bug, found by the lead's reconcile: total 6903, split's own 1h 5070
  //    and 5m 0 -- silently dropping 1833 tokens). cw5m must always be
  //    derived as total - cw1h, never trusted from the split's own field.
  test('cw5m recovered as (total - cw1h) when the split undercounts it', () => {
    const entry = { project: 'p', sessionId: 's9', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const calls = [];
    const usage = { input_tokens: 0, cache_creation_input_tokens: 6903, cache_creation: { ephemeral_1h_input_tokens: 5070, ephemeral_5m_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: 0, speed: 'standard' };
    processLine(JSON.stringify({ type: 'assistant', requestId: 'r9', timestamp: 't', message: { id: 'm9', model: 'claude-sonnet-5', usage, content: [] } }), ctx, (k, p) => k === 'call' && calls.push(p));
    assert(calls[0].cw1h === 5070, `expected cw1h 5070, got ${calls[0].cw1h}`);
    assert(calls[0].cw5m === 1833, `expected cw5m recovered as 6903-5070=1833, got ${calls[0].cw5m}`);
  });

  console.log(failures === 0 ? `ALL ${10} SELFTESTS PASSED` : `${failures} SELFTEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function opt(args, name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined ? def : v;
}


function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return runSelftest();
  if (args.includes('--json')) {
    const since = opt(args, '--since', '2h');
    const file = opt(args, '--file', null);
    const hours = Number(opt(args, '--hours', 168));
    return runJsonDump({ since, file, hours });
  }
  if (args.includes('--serve')) {
    const i = args.indexOf('--serve');
    const maybePort = args[i + 1];
    const port = maybePort && /^\d+$/.test(maybePort) ? Number(maybePort) : 4777;
    const hours = Number(opt(args, '--hours', 24));
    startServer(port, hours);
    return;
  }
  const hours = Number(opt(args, '--hours', 24));
  runTerminalView(hours);
}

if (require.main === module) main();

module.exports = { priceFor, processLine, makeCtx, feedChunk, makeTailBuffer, discoverFiles, sumCalls };
