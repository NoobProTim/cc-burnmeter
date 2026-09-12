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
    for (const file of ['meter.cjs', 'proxy.cjs', 'statusline.cjs', 'wire.cjs']) {
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

  console.error('usage: cc-burnmeter <serve|proxy|statusline|wire|unwire|doctor|selftest> [...args]');
  process.exit(1);
}

main();
