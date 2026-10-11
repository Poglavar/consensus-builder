import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createStageLimiter, runConcurrent, runProcess } from '../lib/parcel-qualification-pool.mjs';

test('two cities overlap, one heavy stage runs, and a failed city does not stop later work', async () => {
    let activeCities = 0, activeHeavy = 0, maxCities = 0, maxHeavy = 0;
    const entered = [], finished = [], errors = [];
    const heavy = createStageLimiter(1);
    await runConcurrent([1, 2, 3, 4], 2, async city => {
        entered.push(city);
        activeCities++;
        maxCities = Math.max(maxCities, activeCities);
        try {
            await delay(10);
            await heavy(async () => {
                activeHeavy++;
                maxHeavy = Math.max(maxHeavy, activeHeavy);
                try {
                    await delay(10);
                    if (city === 2) throw new Error('held city');
                    finished.push(city);
                } finally { activeHeavy--; }
            });
        } finally { activeCities--; }
    }, { onError: (city, error) => errors.push([city, error.message]) });
    assert.equal(maxCities, 2);
    assert.equal(maxHeavy, 1);
    assert.deepEqual(entered, [1, 2, 3, 4]);
    assert.deepEqual(finished, [1, 3, 4]);
    assert.deepEqual(errors, [[2, 'held city']]);
});

test('a stop drains active work without claiming another city', async () => {
    let stop = false;
    const entered = [], finished = [];
    await runConcurrent([1, 2, 3, 4], 2, async city => {
        entered.push(city);
        await delay(10);
        stop = true;
        finished.push(city);
    }, { shouldStop: () => stop });
    assert.deepEqual(entered, [1, 2]);
    assert.deepEqual(finished, [1, 2]);
});

test('process completion and spawn failure are reported without blocking the coordinator', async () => {
    const [ok, missing] = await Promise.all([
        runProcess(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2000, stdio: 'ignore' }),
        runProcess('/nonexistent/parcel-qualification-command', [], { timeoutMs: 2000, stdio: 'ignore' })
    ]);
    assert.equal(ok.status, 0);
    assert.equal(ok.error, null);
    assert.equal(missing.error.code, 'ENOENT');
});

test('timeout waits for the child to exit before releasing its slot', async () => {
    const result = await runProcess(process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { timeoutMs: 300, killAfterMs: 50, stdio: 'ignore' });
    assert.equal(result.error.code, 'ETIMEDOUT');
    assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
    assert.equal(result.status, null);
});
