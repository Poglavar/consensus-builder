#!/usr/bin/env node
// Runs the node:test suites (test/*.node.test.js), two files at a time, each in its own `node --test`.
// Under TEST_RUN=<name> every finished file is recorded in test-runs/<name>/node.jsonl and a rerun with
// the same name skips the recorded files, so a killed run continues instead of starting over.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ledger = require('../../scripts/lib/test-run-ledger.cjs');
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONCURRENCY = 2;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/run-node-tests.mjs --all | <test/file.node.test.js>...

Set TEST_RUN=<name> to record finished files and continue an interrupted run under that name.`);
    process.exit(args.length ? 0 : 1);
}

const files = args.includes('--all')
    ? readdirSync(path.join(BACKEND_DIR, 'test')).filter((f) => f.endsWith('.node.test.js')).sort().map((f) => `test/${f}`)
    : args;
const name = ledger.runName();
const ledgerPath = name && ledger.ledgerFile(BACKEND_DIR, name, 'node');
const finished = name ? ledger.finishedIds(ledger.readLedger(ledgerPath)) : new Set();
const pending = files.filter((file) => !finished.has(file));
const stamp = () => new Date().toISOString();
if (name) {
    console.log(`[${stamp()}] test run ${name}: ${finished.size ? `continuing, ${files.length - pending.length} finished files skipped` : 'starting'}`);
}

// Counts from the spec reporter's closing summary ("ℹ pass 12").
function testCounts(output) {
    const counts = {};
    for (const key of ['pass', 'fail', 'cancelled', 'skipped', 'todo']) {
        const match = output.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'm'));
        if (match && Number(match[1])) counts[key] = Number(match[1]);
    }
    return counts;
}

function runFile(file) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], { cwd: BACKEND_DIR });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('close', (code, signal) => resolve({ file, code, signal, output }));
    });
}

const totals = {};
const failedFiles = [];
let next = 0;
let done = 0;
async function worker() {
    while (next < pending.length) {
        const result = await runFile(pending[next++]);
        done += 1;
        // A file killed by a signal has no result; leave it out of the ledger so a rerun repeats it.
        if (result.signal) throw new Error(`${result.file} was killed by ${result.signal}`);
        const tests = testCounts(result.output);
        for (const [key, n] of Object.entries(tests)) totals[key] = (totals[key] || 0) + n;
        const status = result.code === 0 ? 'passed' : 'failed';
        if (status === 'failed') failedFiles.push(result.file);
        process.stdout.write(`\n[${stamp()}] ${done}/${pending.length} ${status} ${result.file}\n${result.output}`);
        if (name) ledger.appendEntry(ledgerPath, { id: result.file, status, tests });
    }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
console.log(`\n[${stamp()}] ${pending.length} files run: ${Object.entries(totals).map(([k, n]) => `${n} ${k}`).join(', ') || 'no tests'}`);
for (const file of failedFiles) console.log(`  failed: ${file}`);
let failed = failedFiles.length > 0;
if (name) {
    const entries = ledger.readLedger(ledgerPath);
    console.log(ledger.formatSummary(name, 'files', entries));
    failed = ledger.summary(entries).failed.length > 0;
}
process.exit(failed ? 1 : 0);
