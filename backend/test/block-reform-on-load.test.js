// Re-forming blocks as parcels keep loading: only parcels that are in no block yet seed the flood,
// stored blocks they touch merge in, and blocks nothing new touches are left alone.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reformComponents } = require('../../frontend/js/proposals/block-enumeration.js');

// A row of parcels a–e with b missing at first: a | (b) | c – d, and e alone across a road.
const edges = { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'], e: [] };
const neighbours = loaded => id => (edges[id] || []).filter(next => loaded.has(next));
const sorted = components => components.map(c => c.slice().sort()).sort((x, y) => x[0].localeCompare(y[0]));

describe('re-forming blocks after more parcels load', () => {
    it('merges two stored blocks when the parcel that joined them arrives', () => {
        const stored = { a: 'West', c: 'East', d: 'East' };
        const loaded = new Set(['a', 'b', 'c', 'd', 'e']);
        const result = reformComponents(['b'], id => stored[id] || null, neighbours(loaded));
        expect(sorted(result)).toEqual([['a', 'b', 'c', 'd']]);
    });

    it('leaves blocks untouched when no new parcel reaches them', () => {
        const stored = { a: 'West', b: 'West', c: 'West', d: 'West' };
        const loaded = new Set(['a', 'b', 'c', 'd', 'e']);
        const result = reformComponents(['e'], id => stored[id] || null, neighbours(loaded));
        expect(sorted(result)).toEqual([['e']]);
    });

    it('ignores reported parcels that already belong to a block', () => {
        const stored = { a: 'West', b: 'West' };
        const loaded = new Set(['a', 'b']);
        expect(reformComponents(['a', 'b'], id => stored[id] || null, neighbours(loaded))).toEqual([]);
    });

    it('forms one block per component even when several new parcels share it', () => {
        const loaded = new Set(['a', 'b', 'c', 'd']);
        const result = reformComponents(['b', 'd', 'c'], () => null, neighbours(loaded));
        expect(sorted(result)).toEqual([['a', 'b', 'c', 'd']]);
    });
});
