import { describe, it, expect } from 'vitest';
import { caseConflicts, duplicateValueGroups } from './helpers/design-audit.mjs';

describe('copy audit identities', () => {
    it('detects differences in capitalization, with whitespace normalized', () => {
        expect(caseConflicts({ a: 'Create Design', b: ' Create   design ' })).toHaveLength(1);
        expect(caseConflicts({ a: 'Create design', b: ' Create   design ' })).toEqual([]);
    });

    it('keeps punctuation and placeholder names distinct', () => {
        expect(caseConflicts({ a: 'Design', b: 'Design:', c: 'Design…',
            d: 'Open {{title}}', e: 'Open {{name}}', f: 'Open {{Title}}' })).toEqual([]);
        expect(duplicateValueGroups({ a: 'Design', b: 'Design:', c: 'Design…',
            d: 'Open {{title}}', e: 'Open {{name}}', f: 'Open {{Title}}' })).toBe(0);
    });

    it('counts exact reusable copies once per group', () => {
        expect(duplicateValueGroups({ a: 'Close', b: 'Close', c: 'Close', d: 'Cancel' },
            [{ a: 'Fermer', b: 'Fermer', c: 'Fermer', d: 'Annuler' }])).toBe(1);
    });

    it('preserves translation context even when English is identical', () => {
        const en = { a: 'Open', b: 'Open', c: 'Open' };
        expect(duplicateValueGroups(en, [{ a: 'Ouvrir', b: 'Ouvert', c: 'Ouverte' }])).toBe(0);
        // A match in one translation is insufficient if another locale distinguishes it.
        expect(duplicateValueGroups(en, [{ a: 'Ouvrir', b: 'Ouvrir', c: 'Ouvrir' },
            { a: 'Abrir', b: 'Aberto', c: 'Aberta' }])).toBe(0);
    });

    it('does not call incomplete translations reusable', () => {
        expect(duplicateValueGroups({ a: 'Close', b: 'Close' }, [{ a: 'Fermer' }])).toBe(0);
    });
});
