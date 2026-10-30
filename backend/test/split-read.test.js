// The box reader behind POST /buildings/cell and the custom building sources: a capped box is read in
// quarters, merged by id; one failed quarter makes the whole box unavailable; depth and query budgets bound it.
import { describe, expect, it, vi } from 'vitest';
import { splitRead, quarters, boxSideMeters } from '../buildings/split-read.js';

const box = [-74.11, 4.61, -74.10, 4.62];
const idOf = item => item.id;

describe('splitRead', () => {
    it('answers a box the source answers whole with one query', async () => {
        const query = vi.fn(async () => ({ items: [{ id: 'a' }, { id: 'b' }], complete: true }));
        expect(await splitRead(box, query, { idOf })).toEqual({ items: [{ id: 'a' }, { id: 'b' }], complete: true, queries: 1 });
        expect(query).toHaveBeenCalledExactlyOnceWith(box);
    });

    it('reads a capped box in quarters and keeps a building on a quarter edge once', async () => {
        const query = vi.fn(async part => (part === box ? { areaLimited: true }
            : { items: [{ id: 'edge' }, { id: part.join(',') }], complete: true }));
        const read = await splitRead(box, query, { idOf });
        expect(query.mock.calls.slice(1).map(([part]) => part)).toEqual(quarters(box));
        expect(read.items.map(item => item.id).sort()).toEqual(['edge', ...quarters(box).map(part => part.join(','))].sort());
        expect(read).toMatchObject({ complete: true, queries: 5 });
    });

    it('answers the whole box unavailable when one quarter fails, so a fallback can answer it whole', async () => {
        let calls = 0;
        const query = vi.fn(async () => (++calls === 1 ? { areaLimited: true }
            : calls === 3 ? { unavailable: true, retryAfter: 30 } : { items: [{ id: `q${calls}` }], complete: true }));
        expect(await splitRead(box, query, { idOf })).toEqual({ unavailable: true, retryAfter: 30, queries: 3 });
    });

    it('stops splitting at the depth and query budgets and says the answer is incomplete', async () => {
        const capped = vi.fn(async () => ({ areaLimited: true }));
        expect(await splitRead(box, capped, { idOf, maxDepth: 1 })).toEqual({ items: [], complete: false, queries: 5 });
        const budget = await splitRead(box, capped, { idOf, maxQueries: 3 });
        expect(budget).toMatchObject({ complete: false, queries: 3 });
    });

    it('measures a box side in metres', () => {
        expect(boxSideMeters([0, 0, 0.01, 0.01])).toBeCloseTo(1113, 0);
    });
});
