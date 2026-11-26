// The lens pattern's key colours come from the whole key, so Solana keys that share a prefix differ.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { keyColorIndexes } = createRequire(import.meta.url)('../../frontend/js/lens-pattern.js');

describe('lens pattern key colours', () => {
    it('gives every key two different palette slots, the same each time', () => {
        const key = 'G9rL2xqT6m4u3mXrQ7aWb8nJdP1fK5sVyHcE2ZtLwB4';
        const pair = keyColorIndexes(key, 10);
        expect(pair).toEqual(keyColorIndexes(key, 10));
        expect(pair[0]).not.toBe(pair[1]);
        pair.forEach(index => expect(index >= 0 && index < 10).toBe(true));
    });
    it('tells apart base58 keys that the old hex reading coloured alike', () => {
        // The old pattern parsed the first characters as hex: every key starting with a non-hex
        // letter fell back to its position, so these lenses all drew the same stripes.
        const keys = ['GtdgeHqK7aZ1', 'GDYnRx2pQw8L', 'notary01', 'lifecycle01', 'Hiv7iHiMk9Yb', 'J4pAiiTr3mQs'];
        const pairs = new Set(keys.map(key => keyColorIndexes(key, 10).join('-')));
        expect(pairs.size).toBe(keys.length);
    });
    it('treats an EVM address the same in any letter case', () => {
        expect(keyColorIndexes('0xAA2530fe1682190FE63440f5eE8C602108f46790', 10))
            .toEqual(keyColorIndexes('0xaa2530fe1682190fe63440f5ee8c602108f46790', 10));
    });
    it('refuses a palette too small for two colours', () => {
        expect(() => keyColorIndexes('notary01', 1)).toThrow(RangeError);
    });
});
