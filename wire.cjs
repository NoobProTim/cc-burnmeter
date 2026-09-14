#!/usr/bin/env node
'use strict';
// Deliverable 3: wire/unwire ~/.claude/settings.json for cc-burnmeter, plus a
// `doctor` diagnostic. Invoked directly (`node wire.cjs wire --proxy`) or via
// cli.cjs's dispatcher.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

// CLAUDE_CONFIG_DIR relocates the whole ~/.claude tree -- same pattern as
// meter.cjs/proxy.cjs/statusline.cjs (deliverable 5).
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const METER_CONFIG_FILE = path.join(CONFIG_DIR, 'token-meter', 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token-meter', 'token');

// ~/.claude.json is a SIBLING of ~/.claude, not inside it, and Claude Code
// never relocates it with CLAUDE_CONFIG_DIR -- it always reads/writes the real
// one. We only ever read it, to decide the remote-control/enterprise refusal
// below. The env override exists purely so --selftest can feed it a fixture
// without ever touching the real file.
// ponytail: test-only knob, not documented for end users.
const CLAUDE_JSON_FILE = process.env.TOKEN_METER_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');

const ABS_STATUSLINE = path.join(__dirname, 'statusline.cjs');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Signals live in the REAL ~/.claude.json (see CLAUDE_JSON_FILE comment above).
function detectRemoteOrEnterprise() {
  const j = readJSON(CLAUDE_JSON_FILE, {});
  const org = (j.oauthAccount && j.oauthAccount.organizationType) || '';
  const reasons = [];
  if (j.hasUsedRemoteControl) reasons.push('Remote Control has been used on this account (conflicts with a custom ANTHROPIC_BASE_URL)');
  if (/team|enterprise/i.test(org)) reasons.push(`account organizationType is "${org}" (managed settings may refuse or override this)`);
  return reasons;
}

function backupPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${SETTINGS_FILE}.bak-${stamp}-cc-burnmeter`;
}

// Selects the newest backup by MTIME, not filename -- an ISO timestamp with
// hyphens-for-colons does not sort lexically the way you'd expect ("...-10..."
// sorts before "...-2...").
function findNewestBackup() {
  const dir = path.dirname(SETTINGS_FILE);
  const prefix = path.basename(SETTINGS_FILE) + '.bak-';
  let best = null;
  let bestMtime = -1;
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('-cc-burnmeter')) continue;
    const full = path.join(dir, name);
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime > bestMtime) { bestMtime = mtime; best = full; }
  }
  return best;
}

// Probes the proxy's /api/hello BEFORE settings.json is touched, so `--proxy`
// never points Claude Code at a base URL that isn't actually listening.
function probeHello(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function isOurStatusLine(statusLine) {
  const cmd = statusLine && (statusLine.command || statusLine);
  return typeof cmd === 'string' && cmd.includes('statusline.cjs');
}

// Families that accept the [1m] suffix (verified 2026-09-14: fable[1m] and sonnet[1m]
// are accepted, haiku[1m] is rejected with a 400). Never invent a model when none is
// configured -- that would silently change what the user runs.
const ONE_M_FAMILY = /sonnet|opus|fable|mythos/i;
function with1m(model) {
  if (!model) return null;
  if (/\[1m\]$/i.test(model)) return model;
  return ONE_M_FAMILY.test(model) ? `${model}[1m]` : model;
}

function parseArgs(argv) {
  return {
    proxy: argv.includes('--proxy'),
    force: argv.includes('--force'),
    chain: argv.includes('--chain'),
  };
}

async function cmdWire(argv) {
  const opts = parseArgs(argv);
  const settings = readJSON(SETTINGS_FILE, {});

  if (settings.statusLine && !isOurStatusLine(settings.statusLine) && !opts.chain && !opts.force) {
    console.error('wire: settings.json already has a statusLine: ' + JSON.stringify(settings.statusLine));
    console.error('Re-run with --chain to wrap it, or --force to replace it.');
    return 1;
  }

  if (opts.proxy) {
    const reasons = detectRemoteOrEnterprise();
    if (reasons.length && !opts.force) {
      console.error('wire --proxy: refusing (use --force to override):');
      for (const r of reasons) console.error('  - ' + r);
      return 1;
    }
    const port = Number(process.env.TOKEN_METER_PROXY_PORT) || 4778;
    const ok = await probeHello(port);
    if (!ok && !opts.force) {
      console.error(`wire --proxy: proxy not responding on 127.0.0.1:${port}/api/hello -- start it first (node proxy.cjs), or pass --force.`);
      return 1;
    }

    // Capture whatever base URL was already configured, so it survives as
    // "upstream" instead of being silently clobbered by the proxy's own URL.
    if (settings.env && settings.env.ANTHROPIC_BASE_URL) {
      const meterConfig = readJSON(METER_CONFIG_FILE, {});
      if (!meterConfig.upstream) {
        meterConfig.upstream = settings.env.ANTHROPIC_BASE_URL;
        writeJSONAtomic(METER_CONFIG_FILE, meterConfig);
      }
    }

    if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, backupPath());
    settings.env = Object.assign({}, settings.env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ENABLE_TOOL_SEARCH: 'true',
      CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
    });
    // Behind a custom base URL, Claude Code can't verify 1M-context support and
    // budgets 1M models (Sonnet 5, Fable, Opus 4.7+) at 200K -- the other half of
    // the compact-thrash bug (see ROLLBACK.md). That budget is local to Claude
    // Code; the documented fix is the [1m] model alias, which raises the local
    // window (docs: model-config, "LLM gateway"). Per-model, never a global
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS override: Haiku really is 200K.
    const model1m = with1m(settings.model);
    if (model1m) settings.model = model1m;
    else console.error('wire: no "model" in settings.json -- behind the proxy a 1M model is budgeted at 200K. Start sessions with --model sonnet[1m] or fable[1m], or set "model" in settings and re-run wire.');
    settings.statusLine = { type: 'command', command: `${process.execPath} ${ABS_STATUSLINE}` };
    writeJSONAtomic(SETTINGS_FILE, settings);
    console.log(`wired (proxy tier): ANTHROPIC_BASE_URL -> http://127.0.0.1:${port}, statusLine -> ${ABS_STATUSLINE}`);
    if (model1m) console.log(`model -> ${settings.model} -- the [1m] alias keeps the 1M context window behind the proxy`);
    console.log('Restart any ALREADY-OPEN session -- Claude Code reads these at startup, not mid-session. New sessions pick this up automatically.');
    return 0;
  }

  // Transcripts-only tier: just the status line, merged.
  if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, backupPath());
  settings.statusLine = { type: 'command', command: `${process.execPath} ${ABS_STATUSLINE}` };
  writeJSONAtomic(SETTINGS_FILE, settings);
  console.log(`wired (transcripts-only tier): statusLine -> ${ABS_STATUSLINE}`);
  console.log('Re-run with --proxy for live per-call tracking.');
  return 0;
}

function cmdUnwire() {
  const backup = findNewestBackup();
  if (!backup) {
    console.error('unwire: no backup found -- nothing to restore.');
    return 1;
  }
  fs.copyFileSync(backup, SETTINGS_FILE);
  console.log(`unwired: restored ${SETTINGS_FILE} from ${backup}`);
  return 0;
}

function cmdDoctor() {
  const settings = readJSON(SETTINGS_FILE, null);
  const lines = [];
  lines.push(`config dir: ${CONFIG_DIR}`);
  lines.push(`settings.json: ${settings ? 'found' : 'missing'}`);
  if (settings) {
    const base = settings.env && settings.env.ANTHROPIC_BASE_URL;
    lines.push(`ANTHROPIC_BASE_URL: ${base || '(not set -- direct to api.anthropic.com)'}`);
    if (base) {
      lines.push(`ENABLE_TOOL_SEARCH: ${(settings.env && settings.env.ENABLE_TOOL_SEARCH) || 'MISSING -- tool search defaults OFF behind a custom base URL'}`);
      const model = settings.model;
      const needs1m = model ? ONE_M_FAMILY.test(model) && !/\[1m\]$/i.test(model) : true;
      lines.push(`model: ${model || 'not set'}${needs1m ? '  MISSING [1m] -- behind a custom base URL a 1M model is budgeted at 200K (compact-thrash); use e.g. sonnet[1m] or fable[1m]' : ''}`);
    }
    lines.push(`statusLine: ${settings.statusLine ? JSON.stringify(settings.statusLine) : '(not set)'}`);
  }
  // A dashboard opened with no ?token=... loads and then 401s on every fetch
  // with no explanation (deliverable 4) -- doctor prints the working URL.
  const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : null;
  lines.push(`dashboard: http://127.0.0.1:4777/${token ? '?token=' + token : ''}` +
    (token ? '' : '  (no token yet -- run the dashboard once to generate one)'));
  const reasons = detectRemoteOrEnterprise();
  lines.push(`remote-control/enterprise: ${reasons.length ? reasons.join('; ') : 'clear'}`);
  console.log(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

// Runs `node wire.cjs <args>` in a subprocess with CLAUDE_CONFIG_DIR (and, for
// the remote-control cases, TOKEN_METER_CLAUDE_JSON) pointed at temp fixtures
// -- never the real ~/.claude or ~/.claude.json.
function run(args, env) {
  try {
    const out = execFileSync(process.execPath, [__filename, ...args], {
      env: Object.assign({}, process.env, env),
    });
    return { status: 0, out: out.toString('utf8') };
  } catch (e) {
    return { status: e.status == null ? 1 : e.status, out: (e.stdout || '').toString('utf8') + (e.stderr || '').toString('utf8') };
  }
}

async function runSelftest() {
  let failures = 0;
  let total = 0;
  function test(name, fn) {
    total++;
    try { fn(); console.log('ok   -', name); }
    catch (e) { failures++; console.log('FAIL -', name, '--', e.message); }
  }
  async function testAsync(name, fn) {
    total++;
    try { await fn(); console.log('ok   -', name); }
    catch (e) { failures++; console.log('FAIL -', name, '--', e.message); }
  }

  function freshTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'token-meter-wire-selftest-'));
  }
  function claudeJsonFixture(dir, contents) {
    const f = path.join(dir, 'fake-claude.json');
    fs.writeFileSync(f, JSON.stringify(contents));
    return f;
  }

  // 1. Fresh wire (no --proxy) creates settings.json with our statusLine.
  test('wire (transcripts-only) creates statusLine on an empty config dir', () => {
    const tmp = freshTmp();
    const res = run(['wire'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status === 0, 'expected exit 0, got ' + res.status + ': ' + res.out);
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
    assert(isOurStatusLineFixture(settings.statusLine), 'statusLine not set to our statusline.cjs');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 2. Re-wiring over our OWN statusLine needs neither --chain nor --force,
  // and backs up the settings.json that existed before this run.
  test('re-wire over our own statusLine is idempotent and backs up the old file', () => {
    const tmp = freshTmp();
    run(['wire'], { CLAUDE_CONFIG_DIR: tmp });
    const res = run(['wire'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status === 0, 're-wire should succeed, got ' + res.status + ': ' + res.out);
    const backups = fs.readdirSync(tmp).filter((n) => n.includes('.bak-'));
    assert(backups.length === 1, 'expected exactly one backup, got ' + backups.length);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 3. A pre-existing FOREIGN statusLine refuses without --chain/--force, and
  // leaves settings.json byte-identical.
  test('wire refuses to clobber a foreign statusLine without --chain/--force', () => {
    const tmp = freshTmp();
    const settingsFile = path.join(tmp, 'settings.json');
    const before = JSON.stringify({ statusLine: { type: 'command', command: 'some-other-tool' } });
    fs.writeFileSync(settingsFile, before);
    const res = run(['wire'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status !== 0, 'expected non-zero exit');
    assert(fs.readFileSync(settingsFile, 'utf8') === before, 'settings.json must be untouched on refusal');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 4. --force overrides the foreign-statusLine refusal.
  test('wire --force overrides a foreign statusLine', () => {
    const tmp = freshTmp();
    const settingsFile = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: 'some-other-tool' } }));
    const res = run(['wire', '--force'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status === 0, 'expected exit 0 with --force, got ' + res.status + ': ' + res.out);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert(isOurStatusLineFixture(settings.statusLine), 'statusLine should now be ours');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 5. --proxy refuses when the fixture ~/.claude.json shows Remote Control
  // has been used, without --force -- and takes --force to proceed. Feeds a
  // case KNOWN to refuse first (CE-017), never touches the real ~/.claude.json.
  await testAsync('wire --proxy refuses when Remote Control has been used, unless --force', async () => {
    const tmp = freshTmp();
    const claudeJson = claudeJsonFixture(tmp, { hasUsedRemoteControl: true });
    const res = run(['wire', '--proxy'], { CLAUDE_CONFIG_DIR: tmp, TOKEN_METER_CLAUDE_JSON: claudeJson });
    assert(res.status !== 0, 'expected refusal, got exit ' + res.status);
    assert(!fs.existsSync(path.join(tmp, 'settings.json')), 'settings.json must not be written on refusal');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 6. --proxy with --force AND a real, responding fake /api/hello succeeds
  // even with the Remote Control fixture set.
  await testAsync('wire --proxy --force succeeds against a responding fake proxy', async () => {
    const tmp = freshTmp();
    const claudeJson = claudeJsonFixture(tmp, { hasUsedRemoteControl: true });
    const server = http.createServer((req, res) => {
      if (req.url === '/api/hello') { res.writeHead(200); res.end('ok'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ model: 'fable' }));
    const res = run(['wire', '--proxy', '--force'], {
      CLAUDE_CONFIG_DIR: tmp, TOKEN_METER_CLAUDE_JSON: claudeJson, TOKEN_METER_PROXY_PORT: String(port),
    });
    server.close();
    assert(res.status === 0, 'expected exit 0, got ' + res.status + ': ' + res.out);
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
    assert(settings.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${port}`, 'ANTHROPIC_BASE_URL not wired to the proxy port');
    assert(settings.env.ENABLE_TOOL_SEARCH === 'true', 'ENABLE_TOOL_SEARCH not set');
    assert(settings.model === 'fable[1m]', `configured model must be PRESERVED and given the [1m] suffix, got ${settings.model}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 6b. The [1m] suffix is never invented and never applied to a 200K family:
  // no model stays unset (with a warning), haiku stays haiku (haiku[1m] is a 400).
  test('with1m: preserves the configured model, skips haiku, never invents a default', () => {
    assert(with1m('fable') === 'fable[1m]', 'fable -> fable[1m]');
    assert(with1m('claude-sonnet-5') === 'claude-sonnet-5[1m]', 'full sonnet id gets the suffix');
    assert(with1m('opus[1m]') === 'opus[1m]', 'already suffixed is untouched');
    assert(with1m('haiku') === 'haiku', 'haiku must NOT get [1m] (API rejects it)');
    assert(with1m(undefined) === null, 'no model configured -> null, never a made-up default');
  });

  // 7. --proxy without --force refuses when nothing is listening at all
  // (probeHello fails), even with a clean ~/.claude.json fixture.
  await testAsync('wire --proxy refuses when the proxy is not responding', async () => {
    const tmp = freshTmp();
    const claudeJson = claudeJsonFixture(tmp, {});
    const res = run(['wire', '--proxy'], {
      CLAUDE_CONFIG_DIR: tmp, TOKEN_METER_CLAUDE_JSON: claudeJson, TOKEN_METER_PROXY_PORT: '1',
    });
    assert(res.status !== 0, 'expected refusal when nothing answers /api/hello');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 8. Backup selection is by MTIME, not filename sort: write an "older-named"
  // backup with a NEWER mtime and confirm unwire picks it.
  test('unwire restores the newest backup by mtime, not lexical filename order', () => {
    const tmp = freshTmp();
    const settingsFile = path.join(tmp, 'settings.json');
    const lexicallyFirst = `${settingsFile}.bak-2019-01-10T00-00-00-000Z-cc-burnmeter`;
    const older = `${settingsFile}.bak-2020-01-01T00-00-00-000Z-cc-burnmeter`;
    // lexicallyFirst's NAME sorts before older's (2019 < 2020) but is written
    // FIRST, so its mtime is the real oldest; older is written second, a few
    // ms later, so its mtime is the real newest despite the "older" name/date.
    fs.writeFileSync(lexicallyFirst, JSON.stringify({ marker: 'lexically-first-but-must-not-win' }));
    fs.writeFileSync(older, JSON.stringify({ marker: 'older' }));
    fs.writeFileSync(settingsFile, JSON.stringify({ marker: 'current' }));
    const res = run(['unwire'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status === 0, 'expected exit 0, got ' + res.status + ': ' + res.out);
    const restored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert(restored.marker === 'older', 'expected the mtime-newest backup ("older"-named) to win, got ' + restored.marker);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 9. unwire with no backup present fails cleanly instead of crashing.
  test('unwire with no backup present exits non-zero without crashing', () => {
    const tmp = freshTmp();
    const res = run(['unwire'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status !== 0, 'expected non-zero exit');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 10. doctor prints the tokenized dashboard URL and never crashes on a
  // fresh/empty config dir.
  test('doctor runs clean on an empty config dir and reports settings.json missing', () => {
    const tmp = freshTmp();
    const res = run(['doctor'], { CLAUDE_CONFIG_DIR: tmp });
    assert(res.status === 0, 'expected exit 0, got ' + res.status);
    assert(res.out.includes('settings.json: missing'), 'expected doctor to report missing settings.json');
    assert(res.out.includes('dashboard: http://127.0.0.1:4777/'), 'expected doctor to print the dashboard URL');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  console.log('');
  console.log(failures === 0 ? `ALL ${total} WIRE SELFTESTS PASSED` : `${failures} WIRE SELFTEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

function isOurStatusLineFixture(statusLine) {
  return isOurStatusLine(statusLine);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--selftest') return runSelftest();
  if (cmd === 'wire') process.exitCode = await cmdWire(rest);
  else if (cmd === 'unwire') process.exitCode = cmdUnwire();
  else if (cmd === 'doctor') process.exitCode = cmdDoctor();
  else {
    console.error('usage: wire.cjs <wire|unwire|doctor> [--proxy] [--force] [--chain]');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { cmdWire, cmdUnwire, cmdDoctor, detectRemoteOrEnterprise, findNewestBackup, CONFIG_DIR, SETTINGS_FILE, CLAUDE_JSON_FILE };
