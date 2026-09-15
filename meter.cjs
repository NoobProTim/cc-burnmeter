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
const crypto = require('crypto');
const readline = require('readline');
const { EventEmitter } = require('events');

const HOME = os.homedir();
const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '0.0.0'; } })();
// CLAUDE_CONFIG_DIR relocates the whole ~/.claude tree -- honour it the same
// way Claude Code itself does, and the same way proxy.cjs does (deliverable 5).
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS_DIR = process.env.TOKEN_METER_PROJECTS_DIR || path.join(CONFIG_DIR, 'projects');
const METER_DIR = path.join(CONFIG_DIR, 'token-meter');
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
  // Claude Code slugifies a project's absolute cwd by replacing path
  // separators with '-' (e.g. /Users/alice/foo -> -Users-alice-foo, and the
  // same on Windows with backslashes). Derive the home prefix from the real
  // homedir (not CONFIG_DIR, which may be relocated) instead of a literal.
  const homePrefix = os.homedir().replace(/[\\/]/g, '-') + '-';
  const stripped = slug.startsWith(homePrefix) ? slug.slice(homePrefix.length) : slug;
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

// Who caused this turn? `isMeta` alone cannot tell: task notifications, compaction
// summaries, slash-command expansions and cron wakeups all arrive as ordinary user
// records. Classify by content shape instead. `label` is never private prompt text --
// it is a task id, a command name or a skill name, so it is safe to show even with
// prompt previews off. Kinds: founder | task | slash | local | compaction | cron |
// interrupt | skill | image | meta.
function classifySource(text, record) {
  const t = (text || '').replace(/^\s+/, '');
  if (record && record.isMeta === true) {
    if (/^\[Image/.test(t)) return { kind: 'image', label: 'image' };
    const m = /Base directory for this skill: .*?[\\/]skills[\\/]([^\s\\/]+)/.exec(t) || /<command-name>\/?([^<]+)<\/command-name>/.exec(t);
    if (m) return { kind: 'skill', label: m[1].trim() };
    if (/<observed_from_primary_session>/.test(t)) return { kind: 'meta', label: 'claude-mem' };
    return { kind: 'meta', label: null };
  }
  if (/^<task-notification>/.test(t)) {
    const m = /<task-id>([^<]+)<\/task-id>/.exec(t);
    return { kind: 'task', label: m ? m[1].trim() : null };
  }
  if (/^<command-(name|message)>/.test(t)) {
    const m = /<command-name>\/?([^<]+)<\/command-name>/.exec(t);
    return { kind: 'slash', label: m ? '/' + m[1].trim() : null };
  }
  if (/^<local-command-(stdout|caveat)>/.test(t)) return { kind: 'local', label: null };
  if (/^This session is being continued from a previous conversation/.test(t)) return { kind: 'compaction', label: 'summary' };
  if (/^\[Request interrupted/.test(t)) return { kind: 'interrupt', label: null };
  if (/^Scheduled wakeup|<<autonomous-loop|^\/loop\b/i.test(t)) return { kind: 'cron', label: null };
  if (/^\/[a-z][\w:-]*(\s|$)/i.test(t)) return { kind: 'slash', label: t.split(/\s/)[0] };
  return { kind: 'founder', label: null };
}

// Session-level facts that ride on most records (branch, CLI version, cwd,
// permission mode). Emitted only when a value changes, so the bus stays quiet.
function captureMeta(record, ctx, emit) {
  const next = {};
  let changed = false;
  for (const k of ['gitBranch', 'version', 'cwd', 'permissionMode']) {
    if (record[k] != null && record[k] !== ctx.meta[k]) {
      ctx.meta[k] = record[k];
      next[k] = record[k];
      changed = true;
    }
  }
  if (changed) emit('meta', next);
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
    meta: {},
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
    effort: record.perTurnEffort || record.effort || null,
    turnId: ctx.currentTurn ? ctx.currentTurn.turnId : null,
    turnSource: ctx.currentTurn ? ctx.currentTurn.source : null,
    turnLabel: ctx.currentTurn ? ctx.currentTurn.label : null,
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
  if (type === 'user' || type === 'assistant' || type === 'system') captureMeta(record, ctx, emit);

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
      if (toolNames.length) ctx.idle = false;
    } else {
      // A reply with no tool_use ends the model's side of the turn.
      ctx.idle = !toolNames.length;
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
    if (record.isMeta === true) {
      // Not a prompt: a skill body, an image attachment or another injected
      // block. It still costs tokens on the next call, so attribute it there.
      const src = classifySource(extractText(content), record);
      ctx.pendingInjected.push({ type: src.kind, name: src.label, bytes: byteLen(content) });
      // ...unless it arrives after the last reply finished (or before any turn): then it
      // IS the next input. claude-mem's observer runs on nothing else, and left inside the
      // previous turn every observer call inherited that turn's source ("compact").
      if (src.kind !== 'meta' || (ctx.currentTurn && !ctx.idle)) return;
    }
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
    if (ctx.currentTurn && !isEmptyMeta(ctx.currentTurn)) finishTurn(ctx, emit);
    ctx.idle = false;
    const text = extractText(content);
    const src = classifySource(text, record);
    ctx.currentTurn = {
      turnId: record.uuid || ctx.sessionId + ':' + record.timestamp,
      ts: record.timestamp,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      agentLabel: ctx.agentLabel,
      promptPreview: SHOW_PROMPTS ? text.slice(0, 140).replace(/\s+/g, ' ') : null,
      promptChars: text.length,
      source: src.kind,
      label: src.label,
      calls: [],
      durationMs: null,
      messageCount: null,
    };
    return;
  }

  if (type === 'attachment') {
    const a = record.attachment || {};
    // A hook's stdout is what actually lands in context; size that, not the
    // whole record (which repeats it under `rendered`).
    const payload = a.content != null ? a.content : a.stdout != null ? a.stdout : line;
    ctx.pendingInjected.push({ type: a.type || 'attachment', name: a.hookName || null, bytes: byteLen(payload), ms: a.durationMs || 0 });
    return;
  }

  if (type === 'queue-operation') {
    // Something arrived while a turn was already running -- a founder message
    // typed into a busy session, or a task notification. Never the text itself.
    if (record.operation === 'enqueue') {
      const src = classifySource(record.content || '', null);
      emit('event', { ts: record.timestamp, sessionId: ctx.sessionId, kind: 'queued', detail: { source: src.kind, label: src.label, chars: (record.content || '').length } });
    }
    return;
  }

  if (type === 'system') {
    if (record.subtype === 'compact_boundary') {
      emit('event', { ts: record.timestamp, sessionId: ctx.sessionId, kind: 'compact', detail: record.compactMetadata });
    } else if (record.subtype === 'turn_duration') {
      if (ctx.currentTurn) {
        ctx.currentTurn.durationMs = record.durationMs;
        ctx.currentTurn.messageCount = record.messageCount != null ? record.messageCount : null;
      }
    }
    return;
  }

  if (type === 'agent-name') {
    ctx.agentLabel = record.agentName;
    return;
  }
}

// An injected message no call answered (a local-command caveat before /compact) is not a turn.
const isEmptyMeta = (t) => t.source === 'meta' && !t.calls.length;

function finishTurn(ctx, emit) {
  const t = ctx.currentTurn;
  t.sums = sumCalls(t.calls);
  // The first call's fresh tokens are what THIS input (plus whatever rode in
  // with it) cost to send; later calls in the turn are tool round-trips.
  t.sums.inputFresh = t.calls.length ? t.calls[0].fresh : 0;
  emit('turn', t);
}

function finalizeCtx(ctx, emit) {
  if (ctx.currentTurn) {
    if (!isEmptyMeta(ctx.currentTurn)) finishTurn(ctx, emit);
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

// Privacy default (deliverable 4): prompt text never leaves the machine
// unless explicitly opted in with --show-prompts. promptChars (a length) is
// harmless and always kept; only the text preview is gated.
let SHOW_PROMPTS = false;

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
      // Per-session aggregates, kept incrementally so /api/state never rescans calls.
      tools: {}, // name -> {uses, results, bytesIn}
      injected: {}, // "type" or "type:name" -> {n, bytes, ms}
      bySource: {}, // turn source kind -> {turns, calls, fresh, out}
      compactions: 0,
      gitBranch: null,
      version: null,
      cwd: null,
      permissionMode: null,
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
      for (const name of payload.tools) {
        const t = s.tools[name] || (s.tools[name] = { uses: 0, results: 0, bytesIn: 0 });
        t.uses++;
      }
      for (const f of payload.fedIn) {
        const t = s.tools[f.tool] || (s.tools[f.tool] = { uses: 0, results: 0, bytesIn: 0 });
        t.results++;
        t.bytesIn += f.bytes;
      }
      for (const inj of payload.injected) {
        const key = inj.name ? `${inj.type}:${inj.name}` : inj.type;
        const a = s.injected[key] || (s.injected[key] = { type: inj.type, name: inj.name || null, n: 0, bytes: 0, ms: 0 });
        a.n++;
        a.bytes += inj.bytes;
        a.ms += inj.ms || 0;
      }
      state.dirty = true;
      bus.emit('sse', { type: 'call', data: payload });
    } else if (kind === 'user-activity') {
      s.lastUserTs = payload.ts;
      state.dirty = true;
      bus.emit('sse', { type: 'inflight', data: { key: s.key, ts: payload.ts } });
    } else if (kind === 'turn') {
      s.turns.push(payload);
      if (s.turns.length > 300) s.turns.shift();
      const k = payload.source || 'founder';
      const b = s.bySource[k] || (s.bySource[k] = { turns: 0, calls: 0, fresh: 0, out: 0, inputFresh: 0 });
      b.turns++;
      b.calls += payload.calls.length;
      b.fresh += payload.sums.fresh;
      b.out += payload.sums.out;
      b.inputFresh += payload.sums.inputFresh || 0;
      state.dirty = true;
      bus.emit('sse', { type: 'turn', data: turnSummary(payload) });
    } else if (kind === 'meta') {
      Object.assign(s, payload);
      state.dirty = true;
    } else if (kind === 'event') {
      const ev = { ts: payload.ts, sessionId: payload.sessionId, kind: payload.kind, detail: payload.detail };
      if (ev.kind === 'compact') s.compactions++;
      state.events.push(ev);
      if (state.events.length > 500) state.events.shift();
      state.dirty = true;
      bus.emit('sse', { type: 'event', data: ev });
    }
  };
}

// A turn without its calls array (which can be large) -- what the feeds show.
function turnSummary(t) {
  return {
    turnId: t.turnId, ts: t.ts, sessionId: t.sessionId, agentId: t.agentId, agentLabel: t.agentLabel,
    source: t.source, label: t.label, promptPreview: t.promptPreview, promptChars: t.promptChars,
    calls: t.calls.length, durationMs: t.durationMs, messageCount: t.messageCount, sums: t.sums,
    model: t.calls.length ? t.calls[t.calls.length - 1].model : null,
  };
}

function topEntries(obj, by, n) {
  return Object.entries(obj).map(([k, v]) => Object.assign({ key: k }, v)).sort((a, b) => b[by] - a[by]).slice(0, n);
}

function mergeAgg(into, from) {
  for (const [k, v] of Object.entries(from)) {
    const t = into[k] || (into[k] = {});
    for (const [f, n] of Object.entries(v)) {
      if (typeof n === 'number') t[f] = (t[f] || 0) + n;
      else if (t[f] == null) t[f] = n;
    }
  }
  return into;
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
    warnings: s.lastWarnings || [],
    turns: s.turns.length,
    compactions: s.compactions,
    gitBranch: s.gitBranch,
    version: s.version,
    cwd: s.cwd,
    permissionMode: s.permissionMode,
    bySource: s.bySource,
    tools: topEntries(s.tools, 'bytesIn', 12),
    injected: topEntries(s.injected, 'bytes', 20),
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
      beta: rec.beta || null,
      warnings: rec.warnings || [],
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
  s.lastWarnings = lc.warnings || []; // latest request's warnings win, including "none"
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

// parseFileFull opens a readline stream per file; an account with hundreds
// of sessions firing them all via Promise.all at once can exhaust file
// descriptors. Cap concurrency with a tiny semaphore.
const PARSE_CONCURRENCY = 32;
async function mapLimit(items, limit, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let idx = 0;
  let inFlight = 0;
  let done = 0;
  return new Promise((resolve, reject) => {
    function pump() {
      while (inFlight < limit && idx < items.length) {
        const i = idx++;
        inFlight++;
        Promise.resolve(fn(items[i], i))
          .then((r) => {
            results[i] = r;
            inFlight--;
            done++;
            if (done === items.length) resolve(results);
            else pump();
          })
          .catch(reject);
      }
    }
    pump();
  });
}

async function startTailer(hoursOpt) {
  entries = discoverFiles({ hours: hoursOpt });
  // Parse live.jsonl BEFORE transcripts: it's the earlier-arriving side of
  // the msgId join in real operation (the proxy sees a response streaming in
  // real time; the transcript line lands once Claude Code finishes writing
  // it), so this ordering makes the forward join work on more calls at
  // startup. The reverse (callsByMsgId) join in buildCall/processLiveLine
  // covers the rest regardless of ordering.
  await startLiveTailer();
  await mapLimit(entries, PARSE_CONCURRENCY, parseFileFull);

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
    // Linux (and some other platforms) reject fs.watch's { recursive: true }.
    // pollGrowth's 3s setInterval above still covers new-file growth; only
    // brand-new session files lose the instant-registration fast path. Say
    // so once rather than degrading silently.
    console.error('token-meter: recursive file watch unsupported here -- falling back to polling mode (3s)');
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
// Random per-machine bearer token (deliverable 4), gating /api/* and /events
// so a page on another origin/device on the LAN can't read call/session data.
// Mode 0600; regenerated only if the file is missing.
function getOrCreateToken() {
  const tokenFile = path.join(METER_DIR, 'token');
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (e) {
    const token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(METER_DIR, { recursive: true });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    return token;
  }
}

function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

// EventSource can't set an Authorization header, so ?token= is accepted too.
function checkAuth(req, url, token) {
  return req.headers['authorization'] === `Bearer ${token}` || url.searchParams.get('token') === token;
}

function startServer(port, hours) {
  startTailer(hours);
  const htmlPath = path.join(__dirname, 'meter.html');
  const token = getOrCreateToken();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // DNS-rebinding guard: refuse any request whose Host header doesn't
    // name this machine, regardless of auth.
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }
    // Ownership handshake, deliberately unauthenticated: the SessionStart hook and
    // `cli url` use it to tell OUR dashboard from another program on the port,
    // and to notice a stale process after a plugin update. Reveals no data.
    if (url.pathname === '/api/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'cc-burnmeter', version: VERSION, pid: process.pid }));
      return;
    }
    if ((url.pathname.startsWith('/api/') || url.pathname === '/events') && !checkAuth(req, url, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
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
      const bySource = {};
      const injected = {};
      const tools = {};
      for (const s of state.sessionsMap.values()) {
        turns.push(...s.turns.slice(-50).map(turnSummary));
        mergeAgg(bySource, s.bySource);
        mergeAgg(injected, s.injected);
        mergeAgg(tools, s.tools);
      }
      turns.sort((a, b) => new Date(a.ts) - new Date(b.ts));
      const live = [...liveCalls.values()].filter((lc) => lc.status !== 'done');
      const body = JSON.stringify({
        sessions,
        calls,
        turns: turns.slice(-200),
        events: state.events.slice(-200),
        live,
        bySource,
        injected: topEntries(injected, 'bytes', 40),
        tools: topEntries(tools, 'bytesIn', 20),
        showPrompts: SHOW_PROMPTS,
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
      res.end(JSON.stringify({ summary: sessionSummary(s), calls: s.calls, turns: s.turns.map((t) => Object.assign(turnSummary(t), { callList: t.calls })), live }));
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
    // The token goes to a terminal, never to a log file: when stderr is not a
    // TTY (the SessionStart hook, launchd, systemd) print the URL without it.
    const p = server.address().port;
    if (process.stderr.isTTY || process.env.TOKEN_METER_PRINT_TOKEN === '1') console.error(`token-meter dashboard: http://127.0.0.1:${p}/?token=${token}`);
    else console.error(`token-meter dashboard: http://127.0.0.1:${p}/ (run \`cc-burnmeter url\` for the link with its token)`);
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

async function runSelftest() {
  let failures = 0;
  let total = 0;
  function test(name, fn) {
    total++;
    try {
      fn();
      console.log('ok   -', name);
    } catch (e) {
      failures++;
      console.log('FAIL -', name, '--', e.message);
    }
  }
  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
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

  // 11. stripSlugPrefix strips the REAL homedir prefix (deliverable 5), not a
  // hardcoded literal; a slug from an unrelated machine/homedir is untouched.
  test('stripSlugPrefix derives its prefix from os.homedir(), not a literal', () => {
    const homeSlug = os.homedir().replace(/[\\/]/g, '-');
    assert(stripSlugPrefix(homeSlug + '-myproject') === 'myproject', 'expected homedir prefix stripped');
    assert(stripSlugPrefix('-some-other-machine-project') === '-some-other-machine-project', 'expected non-matching slug left alone');
  });

  // 12. CLAUDE_CONFIG_DIR relocates METER_DIR/LIVE_FILE/PROJECTS_DIR (checked
  // in a fresh subprocess since these are computed once at module load).
  test('CLAUDE_CONFIG_DIR relocates the meter/config paths', () => {
    const { execFileSync } = require('child_process');
    const tmp = fs.mkdtempSync(require('os').tmpdir() + '/token-meter-selftest-config-');
    try {
      const out = execFileSync(
        process.execPath,
        ['-e', "const m = require(process.argv[1]); console.log(JSON.stringify({c: m.CONFIG_DIR, m: m.METER_DIR, l: m.LIVE_FILE}))", require.resolve('./meter.cjs')],
        { env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp, TOKEN_METER_LIVE_FILE: '', TOKEN_METER_PROJECTS_DIR: '' }) }
      ).toString('utf8');
      const got = JSON.parse(out);
      assert(got.c === tmp, `expected CONFIG_DIR=${tmp}, got ${got.c}`);
      assert(got.m === path.join(tmp, 'token-meter'), `expected METER_DIR under ${tmp}, got ${got.m}`);
      assert(got.l === path.join(tmp, 'token-meter', 'live.jsonl'), `expected LIVE_FILE under ${tmp}, got ${got.l}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 13. mapLimit never runs more than `limit` callbacks concurrently.
  await testAsync('mapLimit caps concurrency at 32 in-flight', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 100 }, (_, i) => i);
    await mapLimit(items, PARSE_CONCURRENCY, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return i * 2;
    });
    assert(maxActive <= PARSE_CONCURRENCY, `expected max concurrency <= ${PARSE_CONCURRENCY}, got ${maxActive}`);
    assert(maxActive > 1, 'expected some real concurrency, not serial execution');
  });

  // 14. promptPreview is redacted (null) unless SHOW_PROMPTS is opted in.
  test('promptPreview null by default; populated with SHOW_PROMPTS=true', () => {
    const entry = { project: 'p', sessionId: 's-privacy', agentId: null, agentLabel: null };
    const turnLine = JSON.stringify({ type: 'user', isMeta: false, uuid: 't-priv', timestamp: 't', message: { role: 'user', content: 'super secret prompt text' } });
    const nextLine = JSON.stringify({ type: 'user', isMeta: false, uuid: 't-priv2', timestamp: 't2', message: { role: 'user', content: 'x' } });
    const turns1 = [];
    {
      const ctx = makeCtx(entry);
      processLine(turnLine, ctx, (k, p) => k === 'turn' && turns1.push(p));
      processLine(nextLine, ctx, (k, p) => k === 'turn' && turns1.push(p)); // flush prior turn
      assert(turns1[0].promptPreview === null, 'expected promptPreview null by default');
    }
    SHOW_PROMPTS = true;
    try {
      const turns2 = [];
      const ctx2 = makeCtx(entry);
      processLine(turnLine, ctx2, (k, p) => k === 'turn' && turns2.push(p));
      processLine(nextLine, ctx2, (k, p) => k === 'turn' && turns2.push(p));
      assert(turns2[0].promptPreview === 'super secret prompt text', `expected preview populated, got ${JSON.stringify(turns2[0] && turns2[0].promptPreview)}`);
    } finally {
      SHOW_PROMPTS = false;
    }
  });

  // 15/16. Auth + Host-check (deliverable 4): a real dashboard subprocess,
  // config-dir relocated to a temp dir so getOrCreateToken() never touches
  // the real ~/.claude/token-meter/token file.
  await testAsync('unauthenticated /api/state request -> 401', async () => {
    const { server, port } = await spawnTestServer();
    try {
      const res = await httpGet(port, '/api/state', {});
      assert(res.status === 401, `expected 401, got ${res.status}`);
    } finally {
      server.kill();
    }
  });
  await testAsync('spoofed Host header -> 403 even with a valid token', async () => {
    const { server, port, token } = await spawnTestServer();
    try {
      const res = await httpGet(port, `/api/state?token=${token}`, { Host: 'evil.example.com' });
      assert(res.status === 403, `expected 403, got ${res.status}`);
    } finally {
      server.kill();
    }
  });

  // 17. Input-source classification: the founder's own words vs everything the
  //     system feeds in as a "user" record. isMeta alone cannot separate these.
  test('classifySource: founder vs task/slash/local/compaction/cron/interrupt/skill/image', () => {
    const c = (t, r) => classifySource(t, r || null);
    assert(c('please fix the build').kind === 'founder', 'plain text is the founder');
    const task = c('<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>');
    assert(task.kind === 'task' && task.label === 'abc123', `task-notification -> task/abc123, got ${JSON.stringify(task)}`);
    const slash = c('<command-message>compact</command-message>\n<command-name>/compact</command-name>');
    assert(slash.kind === 'slash' && slash.label === '/compact', `command expansion -> slash//compact, got ${JSON.stringify(slash)}`);
    assert(c('/model fable').kind === 'slash', 'a raw typed /command is slash');
    assert(c('<local-command-stdout>Compacted</local-command-stdout>').kind === 'local', 'local command output');
    assert(c('This session is being continued from a previous conversation that ran out of context.').kind === 'compaction', 'compaction summary');
    assert(c('Scheduled wakeup (founder asked for one)').kind === 'cron', 'cron wakeup');
    assert(c('[Request interrupted by user for tool use]').kind === 'interrupt', 'interrupt');
    const skill = c('Base directory for this skill: /home/x/.claude/skills/compact-prep\n\n# Compact Prep', { isMeta: true });
    assert(skill.kind === 'skill' && skill.label === 'compact-prep', `skill body -> skill/compact-prep, got ${JSON.stringify(skill)}`);
    assert(c('[Image: original 390x2400]', { isMeta: true }).kind === 'image', 'image attachment');
    assert(c('anything else', { isMeta: true }).kind === 'meta', 'other isMeta is meta');
    assert(c('[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n<observed_from_primary_session>', { isMeta: true }).label === 'claude-mem', 'claude-mem observer label');
  });

  // 18b. claude-mem's observer runs on injected (isMeta) messages only. One that arrives
  //      after a text-only reply is a new turn; before this, every observer call
  //      inherited the source of its last self-compaction and showed as "compact".
  test('injected messages after a finished reply start their own turn', () => {
    const ctx = makeCtx({ project: 'p', sessionId: 's-obs', agentId: null, agentLabel: null });
    const out = { turns: [], calls: [] };
    const emit = (k, p) => { if (k === 'turn') out.turns.push(p); if (k === 'call') out.calls.push(p); };
    const usage = { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1, speed: 'standard' };
    let n = 0;
    const obs = () => processLine(JSON.stringify({ type: 'user', isMeta: true, uuid: 'o' + n, timestamp: 't', message: { role: 'user', content: '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n<observed_from_primary_session>' } }), ctx, emit);
    const reply = (tool) => { n++; processLine(JSON.stringify({ type: 'assistant', requestId: 'r' + n, timestamp: 't', message: { id: 'm' + n, model: 'claude-haiku-4-5', usage, content: tool ? [{ type: 'tool_use', id: 'tu' + n, name: 'Bash' }] : [{ type: 'text', text: 'ok' }] } }), ctx, emit); };
    const user = (content) => processLine(JSON.stringify({ type: 'user', uuid: 'u' + n, timestamp: 't', message: { role: 'user', content } }), ctx, emit);
    obs(); reply(); // an observer transcript opens on an injected message
    user('This session is being continued from a previous conversation.'); reply();
    obs(); reply(); // the call the dashboard labelled "compact"
    const src = out.calls.map((c) => c.turnSource + '/' + c.turnLabel).join(' ');
    assert(src === 'meta/claude-mem compaction/summary meta/claude-mem', `observer calls, got ${src}`);
    // Interactive shapes must not split: an injected block before a prompt's first call,
    // or between tool round-trips, stays inside the founder's turn.
    user('please fix it'); obs(); reply(true);
    user([{ type: 'tool_result', tool_use_id: 'tu' + n, content: 'x' }]); obs(); reply();
    const fnd = out.calls.slice(3).map((c) => c.turnSource).join(' ');
    assert(fnd === 'founder founder', `founder turn must not split, got ${fnd}`);
    // An injected message no call answered (a local-command caveat) is not reported as a turn.
    obs(); user('<command-name>/compact</command-name>');
    assert(!out.turns.some((t) => t.source === 'meta' && !t.calls.length), 'an empty meta turn must not be emitted');
  });

  // 18. A turn carries its source + label, the call carries the turn's source,
  //     and the session aggregates fresh tokens by source.
  test('turn source/label flow to calls and to the per-session bySource aggregate', () => {
    const entry = { project: 'p', sessionId: 's-src', agentId: null, agentLabel: null };
    const ctx = makeCtx(entry);
    const out = { turns: [], calls: [] };
    const emit = (k, p) => { if (k === 'turn') out.turns.push(p); if (k === 'call') out.calls.push(p); };
    const usage = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 7, speed: 'standard' };
    processLine(JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: '<task-notification>\n<task-id>job9</task-id>' } }), ctx, emit);
    processLine(JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: 't2', perTurnEffort: 'high', message: { id: 'm1', model: 'claude-sonnet-5', usage, content: [] } }), ctx, emit);
    processLine(JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 4200, messageCount: 3, timestamp: 't3' }), ctx, emit);
    processLine(JSON.stringify({ type: 'user', uuid: 'u2', timestamp: 't4', message: { role: 'user', content: 'thanks' } }), ctx, emit);
    assert(out.calls[0].turnSource === 'task' && out.calls[0].turnLabel === 'job9', `call should carry turn source, got ${out.calls[0].turnSource}/${out.calls[0].turnLabel}`);
    assert(out.calls[0].effort === 'high', 'call should carry perTurnEffort');
    assert(out.turns.length === 1 && out.turns[0].source === 'task', 'first turn flushed with source task');
    assert(out.turns[0].durationMs === 4200 && out.turns[0].messageCount === 3, 'turn_duration attaches duration + messageCount');
    assert(out.turns[0].sums.inputFresh === 105, `inputFresh = first call fresh (105), got ${out.turns[0].sums.inputFresh}`);
    // aggregate through the real emitter
    const s = getOrCreateSession({ sessionId: 's-src-agg', agentId: null, project: 'p', agentLabel: null, path: null });
    const realEmit = makeEmit({ sessionId: 's-src-agg', agentId: null, project: 'p', agentLabel: null, path: null });
    realEmit('turn', out.turns[0]);
    assert(s.bySource.task && s.bySource.task.turns === 1 && s.bySource.task.fresh === 105, `bySource.task should be {turns:1, fresh:105}, got ${JSON.stringify(s.bySource)}`);
  });

  // 19. Hook output is attributed by hook name with its real payload size, and
  //     a queued message becomes an event without carrying its text.
  test('hook attachments aggregate by name; queue-operation -> queued event without text', () => {
    const entry = { sessionId: 's-hook', agentId: null, project: 'p', agentLabel: null, path: null };
    const s = getOrCreateSession(entry);
    const emit = makeEmit(entry);
    const ctx = makeCtx(entry);
    const events = [];
    const wrap = (k, p) => { if (k === 'event') events.push(p); emit(k, p); };
    const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, speed: 'standard' };
    processLine(JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'x'.repeat(400), durationMs: 30 } }), ctx, wrap);
    processLine(JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'y'.repeat(200), durationMs: 10 } }), ctx, wrap);
    processLine(JSON.stringify({ type: 'attachment', attachment: { type: 'total_tokens_reminder', content: 'z'.repeat(50) } }), ctx, wrap);
    processLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: 't0', content: 'secret text typed while busy' }), ctx, wrap);
    processLine(JSON.stringify({ type: 'assistant', requestId: 'r', timestamp: 't', message: { id: 'mh', model: 'claude-sonnet-5', usage, content: [] } }), ctx, wrap);
    const hook = s.injected['hook_success:SessionStart:startup'];
    assert(hook && hook.n === 2 && hook.bytes === 600 && hook.ms === 40, `expected hook agg {n:2, bytes:600, ms:40}, got ${JSON.stringify(hook)}`);
    assert(s.injected['total_tokens_reminder'].bytes === 50, 'un-named attachment aggregates by type');
    const q = events.find((e) => e.kind === 'queued');
    assert(q && q.detail.source === 'founder' && q.detail.chars === 28, `queued event with source+chars, got ${JSON.stringify(q)}`);
    assert(!JSON.stringify(q).includes('secret'), 'queued event must not carry the message text');
  });

  // 20. The three manifests carry ONE version (plugin pre-mortem §2.11).
  test('package.json, plugin.json and marketplace.json agree on the version', () => {
    const v = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    const pkg = v('package.json').version, plug = v('.claude-plugin/plugin.json').version, mk = v('.claude-plugin/marketplace.json');
    const mkv = mk.plugins && mk.plugins[0] && mk.plugins[0].version;
    assert(pkg && pkg === plug && pkg === mkv, `versions differ: package ${pkg}, plugin ${plug}, marketplace ${mkv}`);
  });

  // 21. /api/hello answers WITHOUT a token and identifies the server; the banner
  //     printed to a non-TTY stderr carries no token (pre-mortem §2.2, §2.4).
  await testAsync('/api/hello is unauthenticated and names the server; non-TTY banner has no token', async () => {
    const { server, port, token } = await spawnTestServer();
    try {
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/hello' }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', reject);
      });
      assert(res.status === 200 && res.body.name === 'cc-burnmeter' && res.body.version === VERSION && res.body.pid > 0, `unexpected hello: ${JSON.stringify(res)}`);
      void token;
    } finally {
      server.kill();
    }
    // banner without TOKEN_METER_PRINT_TOKEN, stderr piped (not a TTY)
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(require('os').tmpdir() + '/token-meter-selftest-banner-');
    const child = spawn(process.execPath, [require.resolve('./meter.cjs'), '--serve', '0'], { env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp, TOKEN_METER_LIVE_FILE: '', TOKEN_METER_PROJECTS_DIR: path.join(tmp, 'projects'), TOKEN_METER_PRINT_TOKEN: '' }), stdio: ['ignore', 'ignore', 'pipe'] });
    const banner = await new Promise((resolve) => { let buf = ''; child.stderr.on('data', (c) => { buf += c; if (/dashboard:/.test(buf)) resolve(buf); }); setTimeout(() => resolve(buf), 4000); });
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    assert(/dashboard: http:\/\/127\.0\.0\.1:\d+\//.test(banner) && !/token=/.test(banner), `non-TTY banner must not carry the token, got: ${banner.trim()}`);
  });

  console.log(failures === 0 ? `ALL ${total} SELFTESTS PASSED` : `${failures} SELFTEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// Spawns `meter.cjs --serve 0` in a subprocess with CLAUDE_CONFIG_DIR pointed
// at a fresh temp dir (never the real ~/.claude), and resolves once its
// startup banner reveals the OS-assigned port + generated token.
function spawnTestServer() {
  const { spawn } = require('child_process');
  const tmp = fs.mkdtempSync(require('os').tmpdir() + '/token-meter-selftest-auth-');
  const child = spawn(process.execPath, [require.resolve('./meter.cjs'), '--serve', '0'], {
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp, TOKEN_METER_LIVE_FILE: '', TOKEN_METER_PROJECTS_DIR: path.join(tmp, 'projects'), TOKEN_METER_PRINT_TOKEN: '1' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.once('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for dashboard startup banner')), 5000);
    child.stderr.on('data', (chunk) => {
      buf += chunk;
      const m = /:(\d+)\/\?token=([0-9a-f]+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ server: child, port: Number(m[1]), token: m[2] });
      }
    });
  });
}

function httpGet(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
  });
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
  // The plugin hook starts the server with no flags; the env var is the only way through it.
  if (args.includes('--show-prompts') || process.env.CC_BURNMETER_SHOW_PROMPTS === '1') SHOW_PROMPTS = true;
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

module.exports = { priceFor, processLine, makeCtx, feedChunk, makeTailBuffer, discoverFiles, sumCalls, stripSlugPrefix, classifySource, CONFIG_DIR, METER_DIR, LIVE_FILE, PROJECTS_DIR, mapLimit };
