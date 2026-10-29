'use strict';

// Ledger of a named test run (TEST_RUN=<name>). Each runner appends one JSON line per finished unit
// (a Playwright test, a Vitest file, a node:test file) as it ends, so a run killed part-way can be
// rerun under the same name and skip everything already recorded. See docs/development.md.

const fs = require('node:fs');
const path = require('node:path');

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A unit that ended in one of these has a result; "interrupted" or a missing line means run it again.
const FINISHED = new Set(['passed', 'failed', 'timedOut', 'skipped']);

function runName(env = process.env) {
    const name = env.TEST_RUN;
    if (!name) return null;
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`TEST_RUN must match ${NAME_PATTERN}, got ${JSON.stringify(name)}`);
    }
    return name;
}

function ledgerFile(packageDir, name, suite) {
    return path.join(packageDir, 'test-runs', name, `${suite}.jsonl`);
}

// A kill can land mid-append, so an unparsable LAST line is dropped; anywhere else it is corruption.
function readLedger(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const lines = text.split('\n').filter(Boolean);
    const entries = [];
    lines.forEach((line, index) => {
        try {
            entries.push(JSON.parse(line));
        } catch (error) {
            if (index !== lines.length - 1) throw new Error(`${file}:${index + 1} is not JSON: ${error.message}`);
        }
    });
    return entries;
}

function appendEntry(file, entry) {
    if (!FINISHED.has(entry.status)) throw new Error(`not a finished status: ${entry.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

// The latest entry per id wins, so a unit recorded twice (rerun by hand) counts once.
function latestById(entries) {
    const byId = new Map();
    for (const entry of entries) byId.set(entry.id, entry);
    return byId;
}

function finishedIds(entries) {
    return new Set(latestById(entries).keys());
}

function summary(entries) {
    const latest = [...latestById(entries).values()];
    const counts = {};
    for (const entry of latest) counts[entry.status] = (counts[entry.status] || 0) + 1;
    const failed = latest.filter((entry) => entry.status === 'failed' || entry.status === 'timedOut');
    return { total: latest.length, counts, failed: failed.map((entry) => entry.id) };
}

function formatSummary(name, unit, entries) {
    const { total, counts, failed } = summary(entries);
    const parts = Object.entries(counts).sort().map(([status, n]) => `${n} ${status}`).join(', ');
    const lines = [`[test run ${name}] ${total} ${unit} finished across all parts${parts ? `: ${parts}` : ''}`];
    for (const id of failed) lines.push(`  failed: ${id}`);
    return lines.join('\n');
}

// Playwright ledgers are named after the config, so a controls run and a plain run of the same
// name keep separate records: playwright.config.ts -> playwright, playwright.controls.config.ts -> playwright.controls.
function playwrightSuite(configFile) {
    return path.basename(configFile || 'playwright.config.ts').replace(/\.config\.[cm]?[jt]s$/, '');
}

// One line of Playwright's --test-list format: "[project] › file:line:column › describe › title".
function playwrightTestListLine({ project, file, line, column, titles }) {
    return [`[${project}]`, `${file}:${line}:${column}`, ...titles].join(' › ');
}

module.exports = {
    runName,
    ledgerFile,
    readLedger,
    appendEntry,
    finishedIds,
    summary,
    formatSummary,
    playwrightSuite,
    playwrightTestListLine,
};
