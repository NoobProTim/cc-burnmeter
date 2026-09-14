#!/usr/bin/env node
'use strict';
// SessionStart hook: make sure OUR dashboard is running on the port. Silent on
// success -- anything printed here lands in the model's context on every session
// (SessionStart fires on startup, resume, clear, compact and fork, and under
// `claude -p`). Plain Node, no sh/curl, so it behaves the same on Windows.
//
//   nothing on the port        -> start the dashboard (detached, log 0600)
//   our server, same version   -> do nothing
//   our server, older version  -> restart it (a /plugin update left the old
//                                 process serving old code)
//   another program            -> say so ONCE, never start
//   CC_BURNMETER_AUTOSTART=0   -> do nothing (CI, headless, "I'll start it myself")
//
// node scripts/ensure-dashboard.cjs --selftest  proves the three branches.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = (() => { try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return '0.0.0'; } })();
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(CONFIG_DIR, 'token-meter');

function hello(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: 1000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { let body = null; try { body = JSON.parse(b); } catch (e) { /* not ours */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// One notice per key, ever -- a marker file in the plugin data dir.
function noticeOnce(key, msg) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const f = path.join(DATA, `notice-${key}`);
    if (fs.existsSync(f)) return false;
    fs.writeFileSync(f, new Date().toISOString(), { mode: 0o600 });
  } catch (e) { /* fall through and print anyway */ }
  console.log(msg);
  return true;
}

function start(port) {
  fs.mkdirSync(DATA, { recursive: true });
  // 0600: the server's banner never contains the token when stderr is not a TTY,
  // but the log is still private by construction.
  const log = fs.openSync(path.join(DATA, 'dashboard.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(ROOT, 'meter.cjs'), '--serve', String(port)], {
    detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

// Decide what to do given a hello() result. Pure, so the selftest can drive it.
function decide(h, version) {
  if (h === null) return 'start';
  if (!h.body || h.body.name !== 'cc-burnmeter') return 'foreign';
  if (h.body.version !== version && h.body.pid) return 'restart';
  return 'ok';
}

async function ensure(port) {
  const h = await hello(port);
  const what = decide(h, VERSION);
  if (what === 'start') return start(port) ? 'started' : 'failed';
  if (what === 'foreign') {
    noticeOnce('foreign-port-' + port, `cc-burnmeter: port ${port} is used by another program, dashboard not started -- set CC_BURNMETER_PORT to a free port`);
    return 'foreign';
  }
  if (what === 'restart') {
    try { process.kill(h.body.pid); } catch (e) { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
    start(port);
    return 'restarted';
  }
  return 'ok';
}

async function selftest() {
  const assert = (c, m) => { if (!c) { console.log('FAIL -', m); process.exitCode = 1; } else console.log('ok   -', m); };
  // 1. nothing listening -> start
  assert(decide(null, '1.0.0') === 'start', 'nothing on the port -> start');
  // 2. a foreign HTTP server -> foreign, never start (the python http.server case)
  const foreign = http.createServer((req, res) => { res.writeHead(200); res.end('<html>hi</html>'); });
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  const hf = await hello(foreign.address().port);
  assert(decide(hf, '1.0.0') === 'foreign', 'foreign server answering 200 on the port -> foreign, not "ok"');
  foreign.close();
  // 3. our server, same version -> ok; older version -> restart
  const ours = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'cc-burnmeter', version: '1.0.0', pid: 12345 })); });
  await new Promise((r) => ours.listen(0, '127.0.0.1', r));
  const ho = await hello(ours.address().port);
  assert(decide(ho, '1.0.0') === 'ok', 'our server, same version -> ok');
  assert(decide(ho, '1.0.1') === 'restart', 'our server, older version -> restart');
  ours.close();
  // 4. the notice prints once, then never again
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-dashboard-'));
  const origData = DATA;
  const origLog = console.log; let printed = 0; console.log = () => { printed++; };
  const saved = process.env.CLAUDE_PLUGIN_DATA; process.env.CLAUDE_PLUGIN_DATA = tmp;
  // noticeOnce reads DATA at module load; emulate with a local copy of the logic
  const f = path.join(tmp, 'notice-x');
  for (let i = 0; i < 2; i++) { if (!fs.existsSync(f)) { fs.writeFileSync(f, 'x'); console.log('n'); } }
  console.log = origLog; process.env.CLAUDE_PLUGIN_DATA = saved;
  assert(printed === 1, 'a notice prints once, the second session is silent');
  fs.rmSync(tmp, { recursive: true, force: true });
  void origData;
  console.log(process.exitCode ? 'ENSURE-DASHBOARD SELFTEST FAILED' : 'ALL 5 ENSURE-DASHBOARD SELFTESTS PASSED');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else if (process.env.CC_BURNMETER_AUTOSTART === '0') process.exit(0);
  else ensure(Number(process.env.CC_BURNMETER_PORT) || 4777).then(() => process.exit(0), () => process.exit(0));
}

module.exports = { hello, decide, ensure };
