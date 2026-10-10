// Lens-member retries: a prerequisite that comes back is waited for with growing delays, and one that never
// comes back fails loudly once the give-up bound is reached.
import { describe, expect, it } from 'vitest';
import { retryWithBackoff } from '../lens/retry.js';

function fakeTime() {
    let t = 0;
    const waits = [];
    return { now: () => t, wait: async ms => { waits.push(ms); t += ms; }, waits };
}

describe('retryWithBackoff', () => {
    it('returns at once when the step succeeds', async () => {
        const time = fakeTime();
        await expect(retryWithBackoff('step failed', async () => 'ok', { ...time, log: () => {} })).resolves.toBe('ok');
        expect(time.waits).toEqual([]);
    });

    it('waits with doubling, capped delays until the prerequisite is back', async () => {
        const time = fakeTime();
        const logs = [];
        let calls = 0;
        const result = await retryWithBackoff('ANNOUNCE FAILED', async () => {
            calls++;
            if (calls < 6) throw new Error('directory refused (502)');
            return 'listed';
        }, { ...time, firstDelayMs: 15000, maxDelayMs: 60000, log: m => logs.push(m) });
        expect(result).toBe('listed');
        expect(time.waits).toEqual([15000, 30000, 60000, 60000, 60000]);
        expect(logs[0]).toBe('ANNOUNCE FAILED (attempt 1): directory refused (502); retrying in 15s');
    });

    it('gives up loudly once the next wait would pass giveUpAfterMs', async () => {
        const time = fakeTime();
        await expect(retryWithBackoff('loading the SAS issuer failed', async () => { throw new Error('fetch failed'); },
            { ...time, firstDelayMs: 1000, maxDelayMs: 4000, giveUpAfterMs: 10000, log: () => {} }))
            .rejects.toThrow('loading the SAS issuer failed: gave up after 4 attempt(s) over 7s: fetch failed');
        expect(time.waits).toEqual([1000, 2000, 4000]);
    });
});
