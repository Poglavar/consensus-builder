import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';

const labels = createRequire(import.meta.url)('../../frontend/js/ui/record-label.js');

describe('record labels', () => {
    it('distinguishes equal titles by the varying end of a CID, not its shared prefix', () => {
        const a = 'bafkreiaaaaaaaaaaaaaaa11111111', b = 'bafkreiaaaaaaaaaaaaaaa22222222';
        expect(labels.label('Park', a)).toBe('Park · …11111111');
        expect(labels.label('Park', b)).toBe('Park · …22222222');
        expect(labels.label(a, a)).toBe('…11111111');
        expect(labels.shortId('local-7')).toBe('local-7');
    });
    it('keeps the original identifier available without treating a title or identifier as HTML', () => {
        const id = '<img src=x onerror=bad()>abcdefgh';
        const badge = labels.badge(makeDocument(), id);
        expect(badge.textContent).toBe('…abcdefgh');
        expect(badge.title).toBe(id);
        expect(badge.querySelector('img')).toBeNull();
        expect(labels.label('Same title', null)).toBe('Same title');
    });
    it('extends colliding suffixes only within the displayed collection', () => {
        const ids = ['bafkreifirst11112222abcdefgh', 'bafkreisecond33334444abcdefgh'];
        expect(labels.shortId(ids[0], ids)).toBe('…2222abcdefgh');
        expect(labels.shortId(ids[1], ids)).toBe('…4444abcdefgh');
        expect(labels.shortId(ids[0], [ids[0], ids[0]])).toBe('…abcdefgh');
    });
});
