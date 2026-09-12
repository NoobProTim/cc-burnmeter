#!/usr/bin/env node
'use strict';
/*
 * Claude Code status line command. Reads the harness's stdin JSON and prints
 * ONE tokens-only line:
 *   Opus 5 │ ctx 244k │ last: +1.7k new · 245k re-sent → 4.4k out (3.2k think) │ session: 31.2M in · 402k out
 * Must be fast and must never throw -- any error prints a short fallback and
 * exits 0.
 *
 * Wiring (~/.claude/settings.json) is done by the lead session, not here:
 *   "statusLine": {"type": "command", "command": "node ~/.claude/token-meter/statusline.cjs"}
 *
 * FOUNDER RULING 2026-09-12: this is a token viewer, not a quota-% viewer.
 * No rate_limits, no limits.jsonl -- dropped entirely.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// CLAUDE_CONFIG_DIR relocates the whole ~/.claude tree -- honour it the same
// way meter.cjs/proxy.cjs do (deliverable 5).
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const METER_DIR = path.join(CONFIG_DIR, 'token-meter');
const CACHE_FILE = process.env.TOKEN_METER_STATUSLINE_CACHE || path.join(METER_DIR, '.statusline-cache.json');
const LIVE_FILE = process.env.TOKEN_METER_LIVE_FILE || path.join(METER_DIR, 'live.jsonl');

function fmtK(n) {
  if (n == null) return '?';
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

// Fast-path field extraction for one JSONL line, without the full engine.
// Returns null for anything that isn't a real (non-synthetic) usage-bearing
// assistant record.
function extractCallTokens(line) {
  if (line.indexOf('"type":"assistant"') === -1 || line.indexOf('"usage"') === -1) return null;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    return null;
  }
  const msg = rec.message;
  if (!msg || !msg.usage || msg.model === '<synthetic>') return null;
  const u = msg.usage;
  const cc = u.cache_creation;
  // Same derivation as meter.cjs's buildCall / proxy.cjs's handleSSEData:
  // cache_creation_input_tokens (the total) is authoritative -- the split's
  // own ephemeral_5m_input_tokens is unreliable and can undercount. Derive
  // 5m as the remainder after 1h, clamped at 0 (measured: rare records where
  // 1h alone exceeds the reported total).
  const totalCacheCreation = u.cache_creation_input_tokens || 0;
  const cw1h = (cc && cc.ephemeral_1h_input_tokens) || 0;
  const cw5m = Math.max(0, totalCacheCreation - cw1h);
  const ctxIn = (u.input_tokens || 0) + cw5m + cw1h + (u.cache_read_input_tokens || 0);
  const out = u.output_tokens || 0;
  const think = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  return { key: msg.id + '|' + rec.requestId, ctxIn, out, cw5m, cw1h, input: u.input_tokens || 0, cr: u.cache_read_input_tokens || 0, think };
}

function readAllCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function writeAllCache(all) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all));
  } catch (e) {
    /* non-fatal: session total just won't persist across calls */
  }
}

// Cumulative session totals via an incremental byte-offset cache (one JSON
// file, keyed by sessionId), so every statusline call only re-scans bytes
// NEW since the call before it -- lead measured 0.45s (spec < 0.1s) on a
// cold catch-up scan of the 224MB lead transcript, so a first-ever-seen
// session does NOT scan its existing history at all: it starts tracking
// from the CURRENT file size onward. That trades "session total since true
// session start" for "session total since token-meter first saw it", which
// is the only way to make EVERY call -- cold or warm -- bounded by new
// bytes only, never by total transcript size.
function updateSessionTotals(transcriptPath, sessionId) {
  const all = readAllCache();
  let cache = all[sessionId];
  let st;
  try {
    st = fs.statSync(transcriptPath);
  } catch (e) {
    return null;
  }
  if (!cache) {
    cache = { offset: st.size, sumIn: 0, sumOut: 0, lastKey: null }; // start from NOW, never catch up historically
  }
  if (st.size < cache.offset) cache = { offset: st.size, sumIn: 0, sumOut: 0, lastKey: null }; // rotated/truncated

  if (st.size > cache.offset) {
    const len = st.size - cache.offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      fs.readSync(fd, buf, 0, len, cache.offset);
    } catch (e) {
      return { sumIn: cache.sumIn, sumOut: cache.sumOut };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    let newOffset = cache.offset + Buffer.byteLength(text);
    // Keep only complete lines; a trailing partial line is left unread so
    // it's picked up whole on the next call (self-heals, at most one line
    // of latency -- correctness over micro-speed here).
    if (text.length && text[text.length - 1] !== '\n') {
      const lastNl = text.lastIndexOf('\n');
      const partial = text.slice(lastNl + 1);
      text = text.slice(0, lastNl + 1);
      newOffset -= Buffer.byteLength(partial);
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const c = extractCallTokens(line);
      if (!c || c.key === cache.lastKey) continue;
      cache.lastKey = c.key;
      cache.sumIn += c.ctxIn;
      cache.sumOut += c.out;
    }
    cache.offset = newOffset;
    all[sessionId] = cache;
    writeAllCache(all);
  } else if (!all[sessionId]) {
    all[sessionId] = cache; // first sighting, no growth yet -- still persist the starting offset
    writeAllCache(all);
  }
  return { sumIn: cache.sumIn, sumOut: cache.sumOut };
}

function lastCallSegment(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const st = fs.statSync(transcriptPath);
    const start = Math.max(0, st.size - 256 * 1024);
    const len = st.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const c = extractCallTokens(lines[i]);
      if (!c) continue;
      const fresh = c.input + c.cw5m + c.cw1h;
      return `last: +${fmtK(fresh)} new · ${fmtK(c.cr)} re-sent → ${fmtK(c.out)} out (${fmtK(c.think)} think)`;
    }
    return '';
  } catch (e) {
    return '';
  }
}

function fallback() {
  process.stdout.write('token-meter: n/a\n');
  process.exit(0);
}

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    return fallback();
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return fallback();
  }
  try {
    const model = (data.model && data.model.display_name) || '?';
    const cw = data.context_window || {};

    const parts = [model];
    if (cw.total_input_tokens != null) parts.push(`ctx ${fmtK(cw.total_input_tokens)}`);

    const last = lastCallSegment(data.transcript_path);
    if (last) parts.push(last);

    if (data.session_id && data.transcript_path) {
      const totals = updateSessionTotals(data.transcript_path, data.session_id);
      if (totals) parts.push(`session: ${fmtK(totals.sumIn)} in · ${fmtK(totals.sumOut)} out`);
    }

    process.stdout.write(parts.join(' │ ') + '\n');
    process.exit(0);
  } catch (e) {
    return fallback();
  }
}

main();
