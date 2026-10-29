// Always retain the coverage report, even when a behavioral test fails.
// Under TEST_RUN=<name> the run is resumable: tests go through scripts/run-resumable.mjs and the report is
// built from the run's ledger, which holds every finished test of every part.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { controlReportFromLedger } from '../helpers/control-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = args => new Promise(resolve => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  child.on('error', error => { console.error(error); resolve(1); });
  child.on('exit', code => resolve(code ?? 1));
});
const args = process.argv.slice(2);
const testRun = process.env.TEST_RUN;
const tests = testRun
  ? await run(['scripts/run-resumable.mjs', testRun, '--config', 'playwright.controls.config.ts', ...args])
  : await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.controls.config.ts', ...args]);
let results = process.env.UI_CONTROL_RESULTS ? [process.env.UI_CONTROL_RESULTS] : [];
if (testRun && !args.includes('--list')) {
  const ledger = createRequire(import.meta.url)('../../scripts/lib/test-run-ledger.cjs');
  const file = ledger.ledgerFile(root, testRun, 'playwright.controls');
  results = [file.replace(/\.jsonl$/, '-results.json')];
  writeFileSync(results[0], JSON.stringify(controlReportFromLedger(ledger.readLedger(file))));
}
const report = args.includes('--list') ? 0 : await run(['scripts/report-controls.mjs', '--check', ...results]);
process.exitCode = tests || report;
