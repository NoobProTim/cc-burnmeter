#!/usr/bin/env node
'use strict';
// Deliverable 3: thin dispatcher so `npx cc-burnmeter <cmd>` reaches the right
// file. Each file already parses its own argv and owns its own --selftest
// (meter.cjs, proxy.cjs, statusline.cjs, wire.cjs) -- this just routes to them
// with spawnSync/stdio:'inherit' rather than re-implementing their CLIs.
const path = require('path');
const { spawnSync } = require('child_process');

function run(file, args) {
  const res = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit' });
  return res.status == null ? 1 : res.status;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'selftest') {
    // Each file owns its own proof; run all four in sequence rather than
    // inventing a combined test runner.
    let failed = false;
    for (const file of ['meter.cjs', 'proxy.cjs', 'statusline.cjs', 'wire.cjs', 'scripts/ensure-dashboard.cjs']) {
      if (run(file, ['--selftest']) !== 0) failed = true;
    }
    process.exit(failed ? 1 : 0);
  }

  if (cmd === 'serve') process.exit(run('meter.cjs', ['--serve', ...rest]));
  if (cmd === 'proxy') process.exit(run('proxy.cjs', rest));
  if (cmd === 'statusline') process.exit(run('statusline.cjs', rest));
  if (cmd === 'wire') process.exit(run('wire.cjs', ['wire', ...rest]));
  if (cmd === 'unwire') process.exit(run('wire.cjs', ['unwire', ...rest]));
  if (cmd === 'doctor') process.exit(run('wire.cjs', ['doctor', ...rest]));

  // `url` prints the dashboard address with its bearer token (the page 401s on
  // every fetch without it); `open` also launches the browser. Used by the skill.
  if (cmd === 'url' || cmd === 'open' || cmd === 'stop') {
    const fs = require('fs');
    const { METER_DIR } = require('./meter.cjs');
    const { hello, decide } = require('./scripts/ensure-dashboard.cjs');
    const port = Number(process.env.CC_BURNMETER_PORT || rest[0] || 4777);
    hello(port).then((h) => {
      const state = decide(h, require('./package.json').version);
      if (cmd === 'stop') {
        if (state === 'start') { console.log(`nothing listening on ${port}`); process.exit(0); }
        if (state === 'foreign') { console.error(`port ${port} is another program, not cc-burnmeter -- not touching it`); process.exit(1); }
        try { process.kill(h.body.pid); console.log(`stopped cc-burnmeter dashboard (pid ${h.body.pid}) on ${port}`); process.exit(0); } catch (e) { console.error(`could not stop pid ${h.body.pid}: ${e.message}`); process.exit(1); }
      }
      // Never hand the token to a page that is not ours (plugin pre-mortem §2.2).
      if (state === 'foreign') { console.error(`port ${port} is used by another program, not cc-burnmeter -- set CC_BURNMETER_PORT and start the dashboard`); process.exit(1); }
      let token = '';
      try { token = fs.readFileSync(path.join(METER_DIR, 'token'), 'utf8').trim(); } catch (e) { /* not started yet */ }
      const url = `http://127.0.0.1:${port}/${token ? '?token=' + token : ''}`;
      console.log(url + (state === 'start' ? '   (dashboard not running: `cc-burnmeter serve` or open a new session)' : token ? '' : '   (no token yet)'));
      if (cmd === 'open' && token && state !== 'start') {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawnSync(opener, [url], { stdio: 'ignore', shell: process.platform === 'win32' });
      }
      process.exit(0);
    });
    return;
  }

  console.error('usage: cc-burnmeter <serve|proxy|statusline|wire|unwire|doctor|url|open|stop|selftest> [...args]');
  process.exit(1);
}

main();
