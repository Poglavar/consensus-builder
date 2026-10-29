// The ledger behind resumable test runs: what counts as finished, how a kill mid-append reads back,
// and the Playwright --test-list line a continued run hands back to Playwright.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ledger = require('../../scripts/lib/test-run-ledger.cjs');

describe('test run ledger', () => {
    let file;
    beforeEach(() => {
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'run-ledger-')), 'test-runs', 'r1', 'vitest.jsonl');
    });

    it('records finished units and reads them back as the set to skip', () => {
        ledger.appendEntry(file, { id: 'test/a.test.js', status: 'passed' });
        ledger.appendEntry(file, { id: 'test/b.test.js', status: 'failed' });
        expect([...ledger.finishedIds(ledger.readLedger(file))]).toEqual(['test/a.test.js', 'test/b.test.js']);
    });

    it('refuses to record a unit that has no result', () => {
        expect(() => ledger.appendEntry(file, { id: 'x', status: 'interrupted' })).toThrow(/not a finished status/);
        expect(ledger.readLedger(file)).toEqual([]);
    });

    it('drops a half-written last line but rejects corruption elsewhere', () => {
        ledger.appendEntry(file, { id: 'a', status: 'passed' });
        fs.appendFileSync(file, '{"id":"b","sta');
        expect(ledger.readLedger(file).map((entry) => entry.id)).toEqual(['a']);
        fs.writeFileSync(file, 'garbage\n{"id":"a","status":"passed"}\n');
        expect(() => ledger.readLedger(file)).toThrow(/:1 is not JSON/);
    });

    it('counts a unit recorded twice once, by its latest result', () => {
        ledger.appendEntry(file, { id: 'a', status: 'failed' });
        ledger.appendEntry(file, { id: 'a', status: 'passed' });
        ledger.appendEntry(file, { id: 'b', status: 'timedOut' });
        expect(ledger.summary(ledger.readLedger(file))).toEqual({ total: 2, counts: { passed: 1, timedOut: 1 }, failed: ['b'] });
        expect(ledger.formatSummary('r1', 'files', ledger.readLedger(file)))
            .toBe('[test run r1] 2 files finished across all parts: 1 passed, 1 timedOut\n  failed: b');
    });

    it('accepts only plain run names, so a name cannot leave test-runs/', () => {
        expect(ledger.runName({})).toBeNull();
        expect(ledger.runName({ TEST_RUN: 'full-2026-10-28' })).toBe('full-2026-10-28');
        expect(() => ledger.runName({ TEST_RUN: '../x' })).toThrow(/TEST_RUN must match/);
    });

    it('writes the line format Playwright reads in --test-list-invert', () => {
        expect(ledger.playwrightTestListLine({
            project: 'chromium', file: 'feedback.spec.ts', line: 5, column: 5, titles: ['form', 'sends the report'],
        })).toBe('[chromium] › feedback.spec.ts:5:5 › form › sends the report');
    });

    it('names Playwright ledgers after their config', () => {
        expect(ledger.playwrightSuite(undefined)).toBe('playwright');
        expect(ledger.playwrightSuite('playwright.controls.config.ts')).toBe('playwright.controls');
    });
});
