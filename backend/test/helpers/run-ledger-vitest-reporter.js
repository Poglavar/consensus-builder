// Vitest reporter for named test runs: under TEST_RUN=<name> it records each test file as it finishes
// in backend/test-runs/<name>/vitest.jsonl. vitest.config.js excludes the recorded files, so rerunning
// with the same TEST_RUN continues where the last run stopped.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ledger = require('../../../scripts/lib/test-run-ledger.cjs');
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default class RunLedgerVitestReporter {
    constructor() {
        this.name = ledger.runName();
        this.file = ledger.ledgerFile(BACKEND_DIR, this.name, 'vitest');
        const finished = ledger.finishedIds(ledger.readLedger(this.file)).size;
        const stamp = new Date().toISOString();
        console.log(finished
            ? `[${stamp}] test run ${this.name}: continuing, ${finished} finished files skipped`
            : `[${stamp}] test run ${this.name}: starting`);
    }

    onTestModuleEnd(testModule) {
        const state = testModule.state();
        if (state !== 'passed' && state !== 'failed' && state !== 'skipped') return;
        const tests = {};
        for (const test of testModule.children.allTests()) {
            const testState = test.result().state;
            tests[testState] = (tests[testState] || 0) + 1;
        }
        ledger.appendEntry(this.file, {
            id: path.relative(BACKEND_DIR, testModule.moduleId).split(path.sep).join('/'),
            status: state,
            tests,
        });
    }

    onTestRunEnd() {
        const entries = ledger.readLedger(this.file);
        console.log(ledger.formatSummary(this.name, 'files', entries));
        // The exit code covers the whole run, so a final part with nothing left still reports earlier failures.
        if (ledger.summary(entries).failed.length) process.exitCode = 1;
    }
}
