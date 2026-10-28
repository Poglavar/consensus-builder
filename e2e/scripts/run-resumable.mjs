#!/usr/bin/env node
// Runs `playwright test` as a named, resumable run: finished tests are recorded in
// test-runs/<name>/<config>.jsonl (playwright.jsonl for the default config), and a rerun with the
// same name skips them.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ledger = require('../../scripts/lib/test-run-ledger.cjs');
const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [name, ...playwrightArgs] = process.argv.slice(2);
if (!name || name === '--help' || name === '-h') {
  console.log(`Usage: node scripts/run-resumable.mjs <run-name> [playwright test args...]

Starts the run, or continues it when test-runs/<run-name>/<config>.jsonl already lists finished
tests (they are skipped with --test-list-invert). Example:
  node scripts/run-resumable.mjs full-2026-10-28 --workers=2 --reporter=list --trace=off`);
  process.exit(name ? 0 : 1);
}

const env = { ...process.env, TEST_RUN: name, TEST_RUN_RESUMABLE: '1' };
ledger.runName(env);
const configIndex = playwrightArgs.findIndex((arg) => arg === '--config' || arg === '-c');
const configFile = configIndex >= 0 ? playwrightArgs[configIndex + 1]
  : playwrightArgs.find((arg) => arg.startsWith('--config='))?.slice('--config='.length);
const suite = ledger.playwrightSuite(configFile);
const file = ledger.ledgerFile(E2E_DIR, name, suite);
const finished = [...ledger.finishedIds(ledger.readLedger(file))];
// An explicit --reporter replaces the config's reporters, which would drop the ledger reporter.
const LEDGER_REPORTER = './helpers/run-ledger-reporter.cjs';
const args = ['playwright', 'test', ...playwrightArgs.map((arg) => (
  arg.startsWith('--reporter=') ? `${arg},${LEDGER_REPORTER}` : arg))];
if (playwrightArgs.includes('--reporter')) throw new Error('pass the reporter as --reporter=<name>');
const stamp = () => new Date().toISOString();
if (finished.length) {
  const skipList = path.join(path.dirname(file), `${suite}-finished.txt`);
  writeFileSync(skipList, `${finished.join('\n')}\n`);
  // When everything already finished, nothing is left to select; that completes the run, not an error.
  args.push('--test-list-invert', skipList, '--pass-with-no-tests');
  console.log(`[${stamp()}] test run ${name}: continuing, ${finished.length} finished tests skipped`);
} else {
  console.log(`[${stamp()}] test run ${name}: starting`);
}
const child = spawnSync('npx', args, { cwd: E2E_DIR, env, stdio: 'inherit' });
// The exit code covers the whole run, so a final part with nothing left still reports earlier failures.
const earlierFailures = ledger.summary(ledger.readLedger(file)).failed.length;
process.exit((child.status ?? 1) || (earlierFailures ? 1 : 0));
