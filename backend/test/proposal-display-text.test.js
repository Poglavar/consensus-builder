import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parcelLabel, text } = require('../../frontend/js/proposals/display-text.js');

const geometryId = `KE-NAIROBI-NM-g1~368402797~-12643572~${'c'.repeat(64)}`;

describe('proposal display text', () => {
    it('shortens only exact geometry-derived parcel identities', () => {
        expect(parcelLabel(geometryId)).toBe(`G1-${'c'.repeat(8)}`);
        expect(parcelLabel('US-CA-SF-3513080')).toBe('US-CA-SF-3513080');
        expect(parcelLabel('KE-NAIROBI-NM-g1~368402797~-12643572~abc')).toBe('KE-NAIROBI-NM-g1~368402797~-12643572~abc');
    });

    it('replaces full canonical identities in display text while preserving authored wording', () => {
        expect(text(`Evidence covers ${geometryId}.`, {})).toBe(`Evidence covers G1-${'c'.repeat(8)}.`);
        expect(text('A human-written Nairobi infill proposal', { cadastreParcelIds: [geometryId] }))
            .toBe('A human-written Nairobi infill proposal');
    });

    it('repairs a generated legacy title from its matching full geometry ID, including a 60-character truncation', () => {
        const proposal = { cadastreParcelIds: [geometryId] };
        const oldFullName = `5-storey infill on parcel ${geometryId.split('-').at(-1)}`;
        const oldTruncatedName = oldFullName.slice(0, 60);
        const expected = `5-storey infill on parcel G1-${'c'.repeat(8)}`;
        expect(text(oldFullName, proposal)).toBe(expected);
        expect(oldTruncatedName).toHaveLength(60);
        expect(text(oldTruncatedName, proposal)).toBe(expected);
    });

    it('leaves normal parcel numbers and authored titles unchanged even when geometry IDs are present', () => {
        expect(text('5-storey infill on parcel 3513080', { cadastreParcelIds: [geometryId] }))
            .toBe('5-storey infill on parcel 3513080');
        expect(text('5-storey infill on parcel G1-cccccccc', { cadastreParcelIds: [geometryId] }))
            .toBe('5-storey infill on parcel G1-cccccccc');
        expect(text('A useful place for the community', { cadastreParcelIds: [geometryId] }))
            .toBe('A useful place for the community');
    });
});
