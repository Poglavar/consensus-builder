// Unit tests for the single-flight gate used by road finalization. Repeated finish triggers must
// share one async run, and both success and failure must release the gate for a later attempt.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSingleFlightGate } = require('../../frontend/js/road-finalization-state.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe('road finalization single-flight gate', () => {
    it('shares one run across repeated finish triggers and unlocks after success', async () => {
        const gate = createSingleFlightGate();
        const blocker = deferred();
        let calls = 0;
        const first = gate.run(async () => {
            calls += 1;
            await blocker.promise;
            return 'created';
        });
        const second = gate.run(() => {
            calls += 1;
            return 'duplicate';
        });

        expect(second).toBe(first);
        expect(gate.isRunning()).toBe(true);
        await Promise.resolve();
        expect(calls).toBe(1);

        blocker.resolve();
        await expect(first).resolves.toBe('created');
        expect(gate.isRunning()).toBe(false);
        await expect(gate.run(() => 'next')).resolves.toBe('next');
    });

    it('unlocks after a rejected finalization', async () => {
        const gate = createSingleFlightGate();
        await expect(gate.run(() => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
        expect(gate.isRunning()).toBe(false);
        await expect(gate.run(() => true)).resolves.toBe(true);
    });
});
