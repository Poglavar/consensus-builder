// Always retain the coverage report, even when a behavioral test fails.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = args => new Promise(resolve => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  child.on('error', error => { console.error(error); resolve(1); });
  child.on('exit', code => resolve(code ?? 1));
});
const args = process.argv.slice(2);
const tests = await run(['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.controls.config.ts', ...args]);
const report = args.includes('--list') ? 0 : await run(['scripts/report-controls.mjs', '--check', ...(process.env.UI_CONTROL_RESULTS ? [process.env.UI_CONTROL_RESULTS] : [])]);
process.exitCode = tests || report;
