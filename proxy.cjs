#!/usr/bin/env node
'use strict';
/*
 * Token Meter live proxy (SPEC.md §9, Tier 2).
 *
 * A minimal, dependency-free pass-through reverse proxy that sits between
 * Claude Code and api.anthropic.com. It forwards every request/response
 * byte-for-byte and unchanged, and on the SIDE records what it saw (byte
 * sizes, token counts, timings -- never secret values or body content) to
 * ~/.claude/token-meter/live.jsonl.
 *
 * node proxy.cjs             -> starts the proxy (127.0.0.1:4778 by default)
 * node proxy.cjs --selftest  -> runs all 9.4 checks against a FAKE local
 *                               upstream only. No real traffic, ever.
 *
 * ⚠ THE BUILDER NEVER: sends real traffic through this, sets
 * ANTHROPIC_BASE_URL, installs launchd, or edits settings. The lead does all
 * of that after reviewing this file. See SPEC.md §9 for the full contract.
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

// CLAUDE_CONFIG_DIR relocates the whole ~/.claude tree (deliverable 5) --
// honour it everywhere the config dir is assumed, same as Claude Code itself.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const METER_DIR = path.join(CONFIG_DIR, 'token-meter');
const LIVE_FILE = process.env.TOKEN_METER_LIVE_FILE || path.join(METER_DIR, 'live.jsonl');
const CONFIG_FILE = path.join(METER_DIR, 'config.json');
// Precedence: PROXY_UPSTREAM env > config.json's "upstream" (written by
// `wire --proxy` when it finds a pre-existing custom ANTHROPIC_BASE_URL) >
// the real Anthropic API.
function readConfiguredUpstream() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return (cfg && typeof cfg.upstream === 'string' && cfg.upstream) || null;
  } catch (e) {
    return null;
  }
}
const UPSTREAM = process.env.PROXY_UPSTREAM || readConfiguredUpstream() || 'https://api.anthropic.com';
const PORT = Number(process.env.PROXY_PORT || 4778);
const W_OUT_CHARS_PER_TOKEN = 3.5; // outEst divisor for streamed delta characters

// ---------------------------------------------------------------------------
// Header + body plumbing (SPEC.md 9.1)
// ---------------------------------------------------------------------------
const HOP_BY_HOP_EXACT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host']);

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_EXACT.has(lk)) continue;
    if (lk.startsWith('proxy-')) continue;
    out[k] = v;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function byteLen(x) {
  if (x == null) return 0;
  return Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x));
}

// ---------------------------------------------------------------------------
// Request breakdown (SPEC.md 9.2 req-start.breakdown) -- built from a PARSED
// COPY of the body; the raw bytes forwarded to upstream are never touched.
// ---------------------------------------------------------------------------
function buildBreakdown(parsedBody) {
  const parts = []; // flattened, ordered: {kind, name?, role?, bytes, cacheControl}
  const systemBlocks = [];
  if (parsedBody && parsedBody.system != null) {
    const sysArr = Array.isArray(parsedBody.system) ? parsedBody.system : [{ type: 'text', text: parsedBody.system }];
    for (const block of sysArr) {
      const bytes = byteLen(block.text != null ? block.text : block);
      const cacheControl = !!block.cache_control;
      systemBlocks.push({ bytes, cacheControl });
      parts.push({ kind: 'system', bytes, cacheControl });
    }
  }

  const tools = [];
  let toolsTotal = 0;
  if (Array.isArray(parsedBody && parsedBody.tools)) {
    for (const t of parsedBody.tools) {
      const bytes = byteLen(t);
      tools.push({ name: t.name, bytes });
      toolsTotal += bytes;
      parts.push({ kind: 'tool', name: t.name, bytes, cacheControl: !!t.cache_control });
    }
  }

  const messages = { count: 0, bytesByRole: {}, bytesByBlockType: {} };
  const toolUseIdToName = new Map();
  if (Array.isArray(parsedBody && parsedBody.messages)) {
    messages.count = parsedBody.messages.length;
    for (const msg of parsedBody.messages) {
      const role = msg.role || 'unknown';
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      for (const block of content) {
        let label = block.type;
        if (block.type === 'tool_use') {
          toolUseIdToName.set(block.id, block.name);
          label = 'tool_use:' + block.name;
        } else if (block.type === 'tool_result') {
          const name = toolUseIdToName.get(block.tool_use_id) || 'unknown';
          label = 'tool_result:' + name;
        }
        const contentForBytes = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : block;
        const bytes = byteLen(contentForBytes);
        messages.bytesByRole[role] = (messages.bytesByRole[role] || 0) + bytes;
        messages.bytesByBlockType[label] = (messages.bytesByBlockType[label] || 0) + bytes;
        parts.push({ kind: 'message', role, blockType: label, bytes, cacheControl: !!block.cache_control });
      }
    }
  }

  let lastCacheControlIndex = -1;
  parts.forEach((p, i) => {
    if (p.cacheControl) lastCacheControlIndex = i;
  });
  const totalBytes = parts.reduce((a, p) => a + p.bytes, 0);
  const cachedPrefixBytes = lastCacheControlIndex >= 0 ? parts.slice(0, lastCacheControlIndex + 1).reduce((a, p) => a + p.bytes, 0) : 0;
  const newTailBytes = totalBytes - cachedPrefixBytes;

  return { systemBlocks, tools, toolsTotal, messages, lastCacheControlIndex, totalBytes, cachedPrefixBytes, newTailBytes };
}

// ---------------------------------------------------------------------------
// live.jsonl writer (SPEC.md 9.2) -- append-only, rotated at startup if big.
// SECURITY: callers must NEVER pass header values for authorization/
// x-api-key/cookie, or any body content, into writeRecord.
// ---------------------------------------------------------------------------
function rotateIfNeeded() {
  try {
    const st = fs.statSync(LIVE_FILE);
    if (st.size > 50 * 1024 * 1024) {
      fs.renameSync(LIVE_FILE, LIVE_FILE.replace(/\.jsonl$/, '.1.jsonl'));
    }
  } catch (e) {
    /* file absent, nothing to rotate */
  }
}

function makeWriter(filePath) {
  rotateIfNeeded();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return function writeRecord(type, fields) {
    const rec = Object.assign({ type, ts: new Date().toISOString() }, fields);
    stream.write(JSON.stringify(rec) + '\n');
  };
}

// ---------------------------------------------------------------------------
// Minimal SSE parser -- fed a STRING copy of response bytes, never the bytes
// forwarded to the client. Dispatches (eventName|null, dataString) per event.
// ---------------------------------------------------------------------------
function makeSSEParser(onEvent) {
  let buf = '';
  let pendingEvent = null;
  let pendingData = [];
  function flush() {
    if (pendingData.length) onEvent(pendingEvent, pendingData.join('\n'));
    pendingEvent = null;
    pendingData = [];
  }
  return function feed(chunkStr) {
    buf += chunkStr;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line === '') {
        flush();
        continue;
      }
      if (line.startsWith(':')) continue; // comment/ping -- forwarded raw, not parsed
      const m = /^([a-zA-Z]+):\s?(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'event') pendingEvent = m[2];
      else if (m[1] === 'data') pendingData.push(m[2]);
    }
  };
}

function decompressStreamFor(encoding) {
  if (!encoding) return null;
  const e = encoding.toLowerCase();
  if (e === 'gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

// ---------------------------------------------------------------------------
// The proxy itself
// ---------------------------------------------------------------------------
let reqCounter = 0;
function nextReqId() {
  reqCounter += 1;
  return Date.now().toString(36) + '-' + reqCounter;
}

// Warnings computed from a req-start's beta header + tool breakdown (deliverable 1).
// See ROLLBACK.md / README.md for the real incident these two rules address.
function computeWarnings(betaHeader, model, breakdown) {
  const warnings = [];
  const tools = (breakdown && breakdown.tools) || [];
  const hasToolSearch = tools.some((t) => t.name === 'ToolSearch');
  if (!hasToolSearch && (tools.length > 60 || (breakdown && breakdown.toolsTotal > 250_000))) {
    warnings.push('tool-search-off');
  }
  // NOTE: there is deliberately NO "200K window" detector here. Behind a custom
  // base URL Claude Code budgets a 1M model at 200K, but that budget is LOCAL to
  // Claude Code -- nothing in the request reveals it (native-1M models send no
  // context-1m beta at all). Detecting it from headers fired on every healthy
  // request. The settings check in `wire doctor` is the right place.
  return warnings;
}

const WARNING_REMEDY = {
  'tool-search-off': 'tool search is OFF (full tool schemas sent every call) -- set env ENABLE_TOOL_SEARCH=true',
};

function startProxy({ port = PORT, upstream = UPSTREAM, liveFile = LIVE_FILE } = {}) {
  const writeRecord = makeWriter(liveFile);
  const upstreamUrl = new URL(upstream);
  const agent = upstreamUrl.protocol === 'https:' ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  const client = upstreamUrl.protocol === 'https:' ? https : http;
  // Once per sessionId per rule, not once per request. Scoped to this
  // startProxy() call so each --selftest server instance starts fresh.
  const warnedOnce = new Set();
  function warnOnce(sessionId, rule) {
    const key = (sessionId || '(no-session)') + ':' + rule;
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    console.error(`token-meter proxy: ${WARNING_REMEDY[rule]}`);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/hello') {
      // Local-only probe target for `wire --proxy` -- never forwarded upstream.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const reqId = nextReqId();
    const startTime = Date.now();
    let responseEnded = false;
    let proxyReqRef = null;
    // Claude Code cancelling (Esc, a retry) must not leave the upstream
    // stream running -- it would keep generating and billing for output
    // nobody reads. Abort the upstream the instant the client goes away.
    req.on('aborted', () => {
      if (!responseEnded && proxyReqRef) proxyReqRef.destroy();
    });
    res.on('close', () => {
      if (!responseEnded) {
        if (proxyReqRef) proxyReqRef.destroy();
        responseEnded = true;
        writeRecord('req-end', { reqId, status: null, durationMs: Date.now() - startTime, errorType: 'client_disconnected' });
      }
    });
    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: 'token-meter proxy: failed to read request body' } }));
      return;
    }

    let parsedBody = null;
    if (bodyBuf.length) {
      try {
        parsedBody = JSON.parse(bodyBuf.toString('utf8'));
      } catch (e) {
        parsedBody = null; // non-JSON body (rare); breakdown just stays empty
      }
    }
    const breakdown = buildBreakdown(parsedBody);
    const sessionId = req.headers['x-claude-code-session-id'] || null;
    const model = (parsedBody && parsedBody.model) || null;
    // anthropic-beta can arrive as a repeated header (string[]) -- normalize
    // to one comma-joined string before any substring test.
    const betaHeader = [].concat(req.headers['anthropic-beta'] || []).join(',');
    const beta = betaHeader || null;
    const warnings = computeWarnings(betaHeader, model, breakdown);
    for (const rule of warnings) warnOnce(sessionId, rule);

    writeRecord('req-start', {
      reqId,
      path: req.url,
      sessionId,
      agentId: req.headers['x-claude-code-agent-id'] || null,
      parentAgentId: req.headers['x-claude-code-parent-agent-id'] || null,
      model,
      maxTokens: (parsedBody && parsedBody.max_tokens) || null,
      thinking: !!(parsedBody && parsedBody.thinking),
      effort: (parsedBody && parsedBody.output_config && parsedBody.output_config.effort) || null,
      stream: !!(parsedBody && parsedBody.stream),
      bodyBytes: bodyBuf.length,
      breakdown,
      beta,
      warnings,
    });

    const outboundHeaders = filterHeaders(req.headers);
    outboundHeaders.host = upstreamUrl.host;

    const targetUrl = new URL(req.url, upstreamUrl);
    const proxyReq = client.request(
      targetUrl,
      { method: req.method, headers: outboundHeaders, agent },
      (proxyRes) => {
        const status = proxyRes.statusCode;
        const respHeaders = filterHeaders(proxyRes.headers);
        res.writeHead(status, respHeaders);

        const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
        const decomp = decompressStreamFor(proxyRes.headers['content-encoding']);

        // Side-channel: parse a COPY (decompressed if needed) without ever
        // touching what's forwarded to the client.
        const ctx = { reqId, startTime, breakdown, msgId: null, outCharsEst: 0, lastProgressAt: 0, finalOutput: null, finalStopReason: null, finalServerToolUse: null };
        let sseParser = null;
        let jsonCopyChunks = null;
        if (isSSE) {
          sseParser = makeSSEParser((eventName, dataStr) => handleSSEData(dataStr, ctx, writeRecord));
        } else {
          jsonCopyChunks = [];
        }
        function feedCopy(textOrBuf) {
          if (isSSE) sseParser(textOrBuf.toString('utf8'));
          else jsonCopyChunks.push(Buffer.isBuffer(textOrBuf) ? textOrBuf : Buffer.from(textOrBuf));
        }

        function finalize() {
          let inputTokens = null;
          if (!isSSE && jsonCopyChunks) {
            try {
              const full = Buffer.concat(jsonCopyChunks).toString('utf8');
              const obj = JSON.parse(full);
              inputTokens = obj.input_tokens != null ? obj.input_tokens : obj.usage && obj.usage.input_tokens != null ? obj.usage.input_tokens : null;
            } catch (e) {
              /* not JSON or empty -- fine, non-streaming record just omits inputTokens */
            }
          }
          if (isSSE && ctx.finalOutput != null) {
            writeRecord('usage-end', { reqId, msgId: ctx.msgId, output: ctx.finalOutput, stopReason: ctx.finalStopReason, serverToolUse: ctx.finalServerToolUse });
          }
          writeRecord('req-end', Object.assign({ reqId, status, durationMs: Date.now() - startTime, errorType: null }, inputTokens != null ? { inputTokens } : {}));
        }

        proxyRes.on('data', (chunk) => {
          // Forward IMMEDIATELY, byte-for-byte -- never buffered.
          res.write(chunk);
          // Side-channel copy for parsing only.
          if (decomp) decomp.write(chunk);
          else feedCopy(chunk);
        });
        if (decomp) {
          decomp.on('data', (dec) => feedCopy(dec));
          // Wait for the decompressor's OWN 'end' -- its final 'data' can
          // fire asynchronously after .end() is called, so finalizing on
          // proxyRes 'end' directly races the last decompressed chunk.
          decomp.on('end', finalize);
        }
        proxyRes.on('end', () => {
          res.end();
          responseEnded = true;
          if (decomp) decomp.end();
          else finalize();
        });
        proxyRes.on('error', () => {
          try {
            res.end();
          } catch (e) {
            /* already ended */
          }
          responseEnded = true;
          writeRecord('req-end', { reqId, status, durationMs: Date.now() - startTime, errorType: 'upstream_stream_error' });
        });
      }
    );

    proxyReqRef = proxyReq;
    // 600s idle timeout, matching Claude Code's own 300s stream watchdog with
    // headroom -- a large-context request's first byte, or a long thinking
    // pause between bytes, can legitimately take well over the 10s this used
    // to be set to, which was cutting off real in-progress responses.
    // Connection failures (ECONNREFUSED / DNS) are a SEPARATE, immediate path:
    // they fire their own 'error' below with no timeout involved at all, so
    // raising this idle timeout does not slow down the down-upstream case.
    proxyReq.setTimeout(600000, () => proxyReq.destroy(new Error('upstream idle timeout')));
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'token-meter proxy: ' + (err.code || err.message || 'upstream unreachable') } }));
      } else {
        try {
          res.end();
        } catch (e) {
          /* already ended */
        }
      }
      responseEnded = true;
      writeRecord('req-end', { reqId, status: 502, durationMs: Date.now() - startTime, errorType: err.code || 'upstream_unreachable' });
    });

    if (bodyBuf.length) proxyReq.write(bodyBuf);
    proxyReq.end();
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') console.error(`token-meter proxy: port ${port} is already in use (another proxy instance?). Not starting a second one.`);
      else console.error(`token-meter proxy: listen failed: ${err.message}`);
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

function handleSSEData(dataStr, ctx, writeRecord) {
  let obj;
  try {
    obj = JSON.parse(dataStr);
  } catch (e) {
    return;
  }
  if (obj.type === 'message_start') {
    const u = obj.message && obj.message.usage;
    if (u) {
      // Same fix as meter.cjs's buildCall: cache_creation_input_tokens (the
      // total) is authoritative; the split's own ephemeral_5m_input_tokens
      // is unreliable (measured on real transcripts), so derive cw5m as the
      // remainder after the split's cw1h rather than trusting it directly.
      const cc = u.cache_creation;
      const totalCacheCreation = u.cache_creation_input_tokens || 0;
      const cw1h = (cc && cc.ephemeral_1h_input_tokens) || 0;
      // Clamped: same rare case as meter.cjs's buildCall (measured
      // 4/68,618 real records where 1h alone exceeds the reported total).
      const cw5m = Math.max(0, totalCacheCreation - cw1h);
      const input = u.input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      ctx.msgId = obj.message.id;

      // breakdownTokensEst (SPEC.md 9.2): scale each request-side byte part
      // by the ratio of exact reported tokens to counted bytes, so the page
      // can show "what was sent" in tokens even though byte counts are all
      // we had before this exact usage landed.
      let breakdownTokensEst = null;
      const bd = ctx.breakdown;
      if (bd && bd.totalBytes > 0) {
        const totalKnownTokens = input + cw5m + cw1h + cr;
        const ratio = totalKnownTokens / bd.totalBytes;
        breakdownTokensEst = {
          system: Math.round(bd.systemBlocks.reduce((a, b) => a + b.bytes, 0) * ratio),
          tools: Math.round(bd.toolsTotal * ratio),
          cachedPrefix: Math.round(bd.cachedPrefixBytes * ratio),
          newTail: Math.round(bd.newTailBytes * ratio),
        };
      }

      writeRecord('usage-start', {
        reqId: ctx.reqId,
        msgId: obj.message.id,
        input,
        cw5m,
        cw1h,
        cr,
        ttfbMs: Date.now() - ctx.startTime,
        breakdownTokensEst,
      });
    }
  } else if (obj.type === 'content_block_delta') {
    const d = obj.delta || {};
    let chars = 0;
    if (d.type === 'text_delta') chars = (d.text || '').length;
    else if (d.type === 'thinking_delta') chars = (d.thinking || '').length;
    else if (d.type === 'input_json_delta') chars = (d.partial_json || '').length;
    ctx.outCharsEst += chars;
    const now = Date.now();
    if (now - ctx.lastProgressAt >= 500) {
      writeRecord('progress', { reqId: ctx.reqId, outEst: Math.round(ctx.outCharsEst / W_OUT_CHARS_PER_TOKEN), blockType: d.type });
      ctx.lastProgressAt = now;
    }
  } else if (obj.type === 'message_delta') {
    if (obj.usage) {
      ctx.finalOutput = obj.usage.output_tokens != null ? obj.usage.output_tokens : ctx.finalOutput;
      ctx.finalServerToolUse = obj.usage.server_tool_use || ctx.finalServerToolUse;
    }
    if (obj.delta && obj.delta.stop_reason) ctx.finalStopReason = obj.delta.stop_reason;
  }
}

// ---------------------------------------------------------------------------
// --selftest: a FAKE local upstream only. No real traffic, ever.
// ---------------------------------------------------------------------------
async function runSelftest() {
  const failures = [];
  let total = 0;
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log('ok   -', name);
    } catch (e) {
      failures.push(name);
      console.log('FAIL -', name, '--', e.message);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-meter-proxy-selftest-'));
  const liveFile = path.join(tmpDir, 'live.jsonl');

  function sseFrame(eventName, data) {
    return (eventName ? `event: ${eventName}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
  }

  // ---- Check 1: SSE pass-through byte-identical, pings/comments included, no buffering ----
  await test('1. SSE pass-through byte-identical, no buffering (event1 < 500ms despite 1s gaps)', async () => {
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      res.write(sseFrame('message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 0 } } }));
      const timer = setInterval(() => {
        res.write(': ping\n\n');
      }, 1000);
      setTimeout(() => {
        clearInterval(timer);
        res.write(sseFrame('message_stop', { type: 'message_stop' }));
        res.end();
      }, 1200);
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { server, port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    try {
      const t0 = Date.now();
      let firstByteAt = null;
      const chunks = [];
      await new Promise((resolve, reject) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/v1/messages?beta=true', headers: { accept: 'text/event-stream' } }, (res) => {
          res.on('data', (c) => {
            if (firstByteAt == null) firstByteAt = Date.now();
            chunks.push(c);
          });
          res.on('end', resolve);
          res.on('error', reject);
        });
        r.on('error', reject);
      });
      assert(firstByteAt - t0 < 500, `expected first byte under 500ms despite 1s upstream gaps, got ${firstByteAt - t0}ms`);
      const got = Buffer.concat(chunks).toString('utf8');
      assert(got.includes(': ping'), 'expected ping comment lines to be forwarded');
      assert(got.includes('message_start'), 'expected message_start event to be forwarded');
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 2: key headers reach upstream unchanged; host rewritten ----
  await test('2. anthropic-beta/version/authorization/session-id headers pass through; host rewritten', async () => {
    let seenHeaders = null;
    const fake = http.createServer((req, res) => {
      seenHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    try {
      await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET', headers: { 'anthropic-beta': 'x-1', 'anthropic-version': '2023-06-01', authorization: 'Bearer test-token', 'x-claude-code-session-id': 'sess-abc' } }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        r.on('error', reject);
        r.end();
      });
      assert(seenHeaders['anthropic-beta'] === 'x-1', 'anthropic-beta must pass through unchanged');
      assert(seenHeaders['anthropic-version'] === '2023-06-01', 'anthropic-version must pass through unchanged');
      assert(seenHeaders['authorization'] === 'Bearer test-token', 'authorization must pass through unchanged');
      assert(seenHeaders['x-claude-code-session-id'] === 'sess-abc', 'x-claude-code-session-id must pass through unchanged');
      assert(seenHeaders['host'] === `127.0.0.1:${fakePort}`, `host must be rewritten to the upstream, got ${seenHeaders['host']}`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 3: request body reaches upstream byte-identical ----
  await test('3. request body reaches upstream byte-identical (hash match)', async () => {
    let seenHash = null;
    const bodyStr = JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello éè unicode' }], stream: false });
    const fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seenHash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    try {
      const expectedHash = crypto.createHash('sha256').update(Buffer.from(bodyStr, 'utf8')).digest('hex');
      await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        r.on('error', reject);
        r.end(bodyStr);
      });
      assert(seenHash === expectedHash, `request body hash mismatch: sent ${expectedHash}, upstream saw ${seenHash}`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 4: records are correct (req-start breakdown, usage-start exact, progress, usage-end cumulative) ----
  await test('4. records correct: req-start breakdown, usage-start exact, progress, usage-end cumulative', async () => {
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame('message_start', { type: 'message_start', message: { id: 'msg_check4', usage: { input_tokens: 111, cache_creation_input_tokens: 22, cache_creation: { ephemeral_5m_input_tokens: 22, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 33, output_tokens: 0 } } }));
      res.write(sseFrame('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello world this is a test' } }));
      res.write(sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }));
      res.end(sseFrame('message_stop', { type: 'message_stop' }));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const recFile = path.join(tmpDir, 'live-check4.jsonl');
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile: recFile });
    try {
      const reqBody = JSON.stringify({
        model: 'claude-sonnet-5',
        system: [{ type: 'text', text: 'you are helpful', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'Bash', description: 'runs bash', input_schema: {} }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }],
        stream: true,
      });
      await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages?beta=true', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        r.on('error', reject);
        r.end(reqBody);
      });
      await new Promise((r) => setTimeout(r, 200)); // let async writes land
      const lines = fs
        .readFileSync(recFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const reqStart = lines.find((l) => l.type === 'req-start');
      const usageStart = lines.find((l) => l.type === 'usage-start');
      const progress = lines.find((l) => l.type === 'progress');
      const usageEnd = lines.find((l) => l.type === 'usage-end');
      assert(!!reqStart, 'expected a req-start record');
      assert(reqStart.breakdown.tools[0].name === 'Bash', 'expected req-start breakdown to name the Bash tool');
      assert(reqStart.breakdown.systemBlocks[0].cacheControl === true, 'expected req-start breakdown to flag the cache_control on the system block');
      assert(!!usageStart, 'expected a usage-start record');
      assert(usageStart.input === 111 && usageStart.cw5m === 22 && usageStart.cr === 33, `expected exact usage-start tokens, got ${JSON.stringify(usageStart)}`);
      assert(usageStart.breakdownTokensEst && usageStart.breakdownTokensEst.tools > 0, `expected a non-empty breakdownTokensEst, got ${JSON.stringify(usageStart.breakdownTokensEst)}`);
      assert(!!progress, 'expected a progress record');
      assert(!!usageEnd, 'expected a usage-end record');
      assert(usageEnd.output === 42 && usageEnd.stopReason === 'end_turn', `expected cumulative usage-end, got ${JSON.stringify(usageEnd)}`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 5: gzip JSON response passes through byte-identical, and a copy is parsed ----
  await test('5. gzip response byte-identical passthrough, decompressed copy parsed', async () => {
    const payload = JSON.stringify({ input_tokens: 77 });
    const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'));
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gz);
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const recFile = path.join(tmpDir, 'live-check5.jsonl');
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile: recFile });
    try {
      const got = await new Promise((resolve, reject) => {
        const chunks = [];
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages/count_tokens', method: 'POST' }, (res) => {
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        r.on('error', reject);
        r.end('{}');
      });
      assert(Buffer.compare(got, gz) === 0, 'expected the gzip bytes to pass through byte-identical');
      await new Promise((r) => setTimeout(r, 200));
      const lines = fs
        .readFileSync(recFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const reqEnd = lines.find((l) => l.type === 'req-end');
      assert(reqEnd && reqEnd.inputTokens === 77, `expected the decompressed copy to be parsed for inputTokens, got ${JSON.stringify(reqEnd)}`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 6: upstream down -> 502 JSON error within 2s ----
  await test('6. upstream unreachable -> 502 JSON error within 2s', async () => {
    // Bind and immediately close a port so the connection is refused.
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${deadPort}`, liveFile });
    try {
      const t0 = Date.now();
      const { status, body } = await new Promise((resolve, reject) => {
        const chunks = [];
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST' }, (res) => {
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        r.on('error', reject);
        r.end('{}');
      });
      assert(Date.now() - t0 < 2000, 'expected a 502 within 2s');
      assert(status === 502, `expected 502, got ${status}`);
      const parsed = JSON.parse(body);
      assert(parsed.type === 'error' && parsed.error && parsed.error.type === 'api_error', `expected the documented error shape, got ${body}`);
    } finally {
      await close();
    }
  });

  // ---- Check 7: secret sentinel never written anywhere under ~/.claude/token-meter ----
  await test('7. secret sentinel: auth header + body text never written to disk', async () => {
    const fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const recFile = path.join(tmpDir, 'live-check7.jsonl');
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile: recFile });
    try {
      const bodyStr = JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'SENTINEL-BODY-456' }] });
      await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { authorization: 'Bearer SENTINEL-AUTH-123', 'content-type': 'application/json' } }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        r.on('error', reject);
        r.end(bodyStr);
      });
      await new Promise((r) => setTimeout(r, 200));
      // Scan runtime OUTPUT only (this test's recFile, plus anything under
      // METER_DIR the proxy could have written) -- excluding our own source
      // (.cjs/.md/.html), which legitimately quotes this literal test
      // vocabulary as instructions/fixtures and would otherwise be an
      // unavoidable false positive against a grep of the whole tree.
      const { execSync } = require('child_process');
      let grepOut = '';
      try {
        grepOut = execSync(
          `grep -r --exclude='*.cjs' --exclude='*.md' --exclude='*.html' "SENTINEL-AUTH-123\\|SENTINEL-BODY-456" "${METER_DIR}" "${recFile}" 2>/dev/null || true`
        ).toString();
      } catch (e) {
        grepOut = e.stdout ? e.stdout.toString() : '';
      }
      assert(grepOut.trim() === '', `expected zero matches for either sentinel in any runtime output, found:\n${grepOut}`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 8: client disconnect aborts the upstream connection within 1s ----
  await test('8. client abort closes the upstream connection within 1s', async () => {
    let upstreamSocketClosedAt = null;
    let abortedAt = null;
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame('message_start', { type: 'message_start', message: { id: 'msg_abort', usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 0 } } }));
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 500);
      req.on('close', () => {
        clearInterval(keepAlive);
        upstreamSocketClosedAt = Date.now();
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    try {
      const clientReq = http.get({ host: '127.0.0.1', port, path: '/v1/messages?beta=true' }, (res) => {
        res.once('data', () => {
          // Got the first event -- now abort, as Claude Code does on Esc/retry.
          abortedAt = Date.now();
          clientReq.destroy();
        });
      });
      await new Promise((resolve, reject) => {
        clientReq.on('error', () => {}); // destroy() triggers a local ECONNRESET-style error; expected
        const check = setInterval(() => {
          if (upstreamSocketClosedAt != null) {
            clearInterval(check);
            resolve();
          } else if (abortedAt != null && Date.now() - abortedAt > 3000) {
            clearInterval(check);
            reject(new Error('upstream connection never closed within the test window'));
          }
        }, 20);
      });
      const elapsed = upstreamSocketClosedAt - abortedAt;
      assert(elapsed < 1000, `expected the upstream connection to close within 1s of the client abort, took ${elapsed}ms`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 9: a 12s-late first byte is NOT killed (proves the old 10s timeout is gone) ----
  await test('9. a 12s-late first byte still completes (600s idle timeout, not 10s)', async () => {
    const fake = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 12000);
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    try {
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages/count_tokens', method: 'POST' }, (res) => {
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        r.on('error', reject);
        r.end('{}');
      });
      assert(body.status === 200, `expected the slow response to complete with 200, got ${body.status}`);
      assert(JSON.parse(body.body).ok === true, 'expected the full response body to arrive intact');
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  }, 20000);

  // ---- Check 10: tool-search-off rule + warn-once-per-session ----
  await test('10. tool-search-off: 215 tools w/o ToolSearch warns (once per session); 16 tools w/ ToolSearch does not', async () => {
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    const origErr = console.error;
    const errLines = [];
    console.error = (...a) => errLines.push(a.join(' '));
    try {
      function post(body, sessionId) {
        return new Promise((resolve, reject) => {
          const r = http.request(
            { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId } },
            (res) => {
              res.resume();
              res.on('end', resolve);
            }
          );
          r.on('error', reject);
          r.end(body);
        });
      }
      const manyTools = Array.from({ length: 215 }, (_, i) => ({ name: 'tool' + i, description: 'd' }));
      const bodyMany = JSON.stringify({ model: 'claude-sonnet-5', tools: manyTools, messages: [] });
      await post(bodyMany, 'sess-many');
      await post(bodyMany, 'sess-many'); // same session -- must warn to stderr only once

      const fewTools = Array.from({ length: 15 }, (_, i) => ({ name: 'tool' + i })).concat([{ name: 'ToolSearch' }]);
      const bodyFew = JSON.stringify({ model: 'claude-sonnet-5', tools: fewTools, messages: [] });
      await post(bodyFew, 'sess-few');

      const lines = fs
        .readFileSync(liveFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const startMany = lines.filter((l) => l.type === 'req-start' && l.sessionId === 'sess-many');
      assert(startMany.length === 2 && startMany.every((l) => l.warnings.includes('tool-search-off')), 'expected tool-search-off on both sess-many requests');
      const startFew = lines.find((l) => l.type === 'req-start' && l.sessionId === 'sess-few');
      assert(!startFew.warnings.includes('tool-search-off'), 'expected no tool-search-off for 16 tools including ToolSearch');
      const warnLines = errLines.filter((l) => l.includes('tool search is OFF'));
      assert(warnLines.length === 1, `expected exactly 1 stderr warning for sess-many (warn-once), got ${warnLines.length}`);
    } finally {
      console.error = origErr;
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  // ---- Check 11: no header-based "200K window" warning (it fired on every healthy 1M request) ----
  await test('11. a native-1M model with no context-1m beta produces NO warning', async () => {
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const { port, close } = await startProxy({ port: 0, upstream: `http://127.0.0.1:${fakePort}`, liveFile });
    try {
      await new Promise((resolve, reject) => {
        const r = http.request(
          { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-native-1m' } },
          (res) => { res.resume(); res.on('end', resolve); }
        );
        r.on('error', reject);
        r.end(JSON.stringify({ model: 'claude-fable-5-1', messages: [] }));
      });
      const rec = fs.readFileSync(liveFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'req-start' && l.sessionId === 'sess-native-1m');
      assert(rec && !rec.warnings.some((w) => /200k/i.test(w)), `expected no 200K warning, got ${JSON.stringify(rec && rec.warnings)}`);
    } finally {
      await close();
      await new Promise((r) => fake.close(r));
    }
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  console.log(failures.length === 0 ? `ALL ${total} PROXY SELFTESTS PASSED` : `${failures.length} PROXY SELFTEST(S) FAILED: ${failures.join('; ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    runSelftest();
  } else {
    // A proxy that dies takes Claude Code down with it (ANTHROPIC_BASE_URL keeps pointing here),
    // so a per-request exception is logged and the process keeps serving. Never write body content.
    process.on('uncaughtException', (err) => console.error(`token-meter proxy: uncaught ${err && err.code ? err.code + ' ' : ''}${err && err.message ? err.message : err}`));
    process.on('unhandledRejection', (err) => console.error(`token-meter proxy: unhandled rejection ${err && err.message ? err.message : err}`));
    startProxy().then(({ port }) => {
      console.error(`token-meter proxy: listening on 127.0.0.1:${port}, forwarding to ${UPSTREAM}`);
    }).catch(() => process.exit(1));
  }
}

module.exports = { startProxy, buildBreakdown, filterHeaders, makeSSEParser };
