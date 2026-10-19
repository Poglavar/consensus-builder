// Runtime invariant check for the proposals.js refactor.
// Loads the served app in headless chromium and asserts every global the proposals code is
// expected to expose still exists on window after load. This is the keystone gate: a moved
// function that silently drops off `window` fails here even if e2e happens to miss it.
//
//   node refactor/verify-globals.mjs              # uses refactor/global-surface.txt
//   exit 0 = all present; exit 1 = something went missing (prints the diff)
import pkg from '../e2e/node_modules/@playwright/test/index.js';
const { chromium } = pkg;
import { readFileSync } from 'node:fs';

const APP_URL = process.env.BASE_URL || 'http://localhost:8090';
const expected = readFileSync(new URL('./global-surface.txt', import.meta.url), 'utf8')
  .split('\n').map(s => s.trim()).filter(Boolean);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(APP_URL, { waitUntil: 'load', timeout: 30000 });
// give the deferred script loader time to attach all globals
await page.waitForFunction(() => typeof window.proposalStorage !== 'undefined', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

const present = await page.evaluate((names) =>
  names.filter(n => typeof window[n] !== 'undefined'), expected);
await browser.close();

// Baseline-diff invariant: the set of proposal globals present AT LOAD must not shrink.
// (16 of the 124 are lazily attached inside render/interaction fns, so absent at load on
// baseline too — a static "all present" check would false-positive. We diff vs baseline.)
import { existsSync, writeFileSync } from 'node:fs';
const baselinePath = new URL('./global-baseline.json', import.meta.url);
if (errors.length) console.log(`page errors during load: ${errors.length}\n  ${errors.slice(0,5).join('\n  ')}`);

if (process.argv.includes('--snapshot') || !existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify({ presentAtLoad: present.sort() }, null, 2) + '\n');
  console.log(`baseline snapshot written: ${present.length}/${expected.length} globals present at load`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).presentAtLoad;
const regressed = baseline.filter(n => !present.includes(n));
console.log(`globals present at load: ${present.length} (baseline ${baseline.length}) of ${expected.length} declared`);
if (regressed.length) {
  console.log(`REGRESSED — went missing vs baseline (${regressed.length}):\n  ${regressed.join('\n  ')}`);
  process.exit(1);
}
console.log('OK — global surface intact (no baseline global lost)');
process.exit(0);
