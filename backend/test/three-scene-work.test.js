// Exercises slicing, cancellation and the retained geometry budget.
import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { forEach, geometryBytes } = createRequire(import.meta.url)('../../frontend/js/three-scene-work.js');
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
