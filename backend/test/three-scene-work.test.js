// Exercises slicing, cancellation and the retained geometry budget.
import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { forEach, geometryBytes, createRefreshQueue } = createRequire(import.meta.url)('../../frontend/js/three-scene-work.js');
it('checks the budget every item and abandons cancelled work', async () => {
    const visited = []; let time = 0, live = true, yields = 0;
    const done = await forEach([1, 2, 3, 4], n => { visited.push(n); time += 7; }, {
        now: () => time, isCurrent: () => live,
        yieldTask: async () => { yields++; if (yields === 2) live = false; }
    });
    expect(visited).toEqual([1, 2]); expect(yields).toBe(2); expect(done).toBe(false);
});
it('counts shared geometry once', () => {
    const geometry = { attributes: { position: { array: new Float32Array(9) } }, index: { array: new Uint16Array(3) } };
    expect(geometryBytes({ traverse: visit => [{ geometry }, { geometry }].forEach(visit) })).toBe(42);
});

it('coalesces a burst and drains updates without interrupting the current family', async () => {
    const families = [];
    let finish;
    const queue = createRefreshQueue(async family => {
        families.push(family);
        if (families.length === 1) await new Promise(resolve => { finish = resolve; });
    });
    const first = queue.request('planned');
    expect(queue.request('planned')).toBe(first);
    await Promise.resolve();
    expect(families).toEqual(['planned']);
    expect(queue.request('existing')).toBe(first);
    queue.request('existing');
    expect(families).toEqual(['planned']);
    finish();
    await first;
    expect(families).toEqual(['planned', 'existing']);
});

it('combines different requested families and drops cancelled scene work', async () => {
    const families = [];
    const queue = createRefreshQueue(async family => families.push(family));
    const cancelled = queue.request('planned');
    queue.cancel();
    const next = queue.request('existing');
    queue.request('planned');
    await Promise.all([cancelled, next]);
    expect(families).toEqual(['all']);
});

it('allows another refresh after a build failure', async () => {
    let fail = true;
    const queue = createRefreshQueue(async () => { if (fail) throw new Error('build failed'); });
    await expect(queue.request()).rejects.toThrow('build failed');
    fail = false;
    await expect(queue.request('existing')).resolves.toBeUndefined();
});
