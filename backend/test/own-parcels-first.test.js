// Unit tests for frontend/js/own-parcels-first.js — the stable partition that shows the user's own
// parcels first in the proposal details list.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sortOwnParcelsFirst } = require('../../frontend/js/own-parcels-first.js');

describe('sortOwnParcelsFirst', () => {
    const mine = new Set(['b', 'd']);
    const isOwn = (id) => mine.has(id);

    it('floats own parcels to the front, preserving relative order on both sides', () => {
        expect(sortOwnParcelsFirst(['a', 'b', 'c', 'd', 'e'], isOwn)).toEqual(['b', 'd', 'a', 'c', 'e']);
    });

    it('is a no-op when the user owns none', () => {
        expect(sortOwnParcelsFirst(['a', 'c', 'e'], isOwn)).toEqual(['a', 'c', 'e']);
    });

    it('is a no-op when the user owns all', () => {
        expect(sortOwnParcelsFirst(['b', 'd'], isOwn)).toEqual(['b', 'd']);
    });

    it('returns a copy (not the input) unchanged when there is no predicate', () => {
        const input = ['a', 'b'];
        const out = sortOwnParcelsFirst(input, null);
        expect(out).toEqual(['a', 'b']);
        expect(out).not.toBe(input);
    });

    it('treats a throwing predicate as not-owned rather than crashing', () => {
        const boom = () => { throw new Error('nope'); };
        expect(sortOwnParcelsFirst(['a', 'b'], boom)).toEqual(['a', 'b']);
    });

    it('returns [] for non-array input', () => {
        expect(sortOwnParcelsFirst(null, isOwn)).toEqual([]);
        expect(sortOwnParcelsFirst(undefined, isOwn)).toEqual([]);
    });
});
