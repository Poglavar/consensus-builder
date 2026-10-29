// Unit tests for frontend/js/proposals/publish-terms.js: the one choke point that says whether a design
// may be published on its own, including the exact size preflight before any network upload.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const terms = require('../../frontend/js/proposals/publish-terms.js');

const FALLBACK = 'This design exceeds the 10 MiB publication limit. Reduce its extent or detail before sharing; it is saved locally.';
const oversized = () => ({ goal: 'buildings', geometry: { buildings: [] }, buildingProposal: { notes: 'x'.repeat(10 * 1024 * 1024) } });

describe('publishRefusal', () => {
    afterEach(() => { delete globalThis.i18n; });

    it('lets every kind of design through on its own, parcel layouts included, and nothing at all', () => {
        for (const record of [{ goal: 'park' }, { goal: 'road-track' }, { goal: 'single' }, { goal: 'urban-rule' },
            { goal: 'parcel-layout', parcelLayout: { algorithm: 'equal', plots: [] } }, {}, null, undefined]) {
            expect(terms.publishRefusal(record)).toBeNull();
        }
    });

    it('words the refusal in the page language, and falls back when the key is missing or the lookup fails', () => {
        const asked = [];
        globalThis.i18n = { t: key => { asked.push(key); return 'Dizajn je veći od 10 MiB.'; } };
        expect(terms.publishRefusal(oversized()).message).toBe('Dizajn je veći od 10 MiB.');
        expect(asked).toEqual(['proposals.share.errors.tooLarge']);

        globalThis.i18n = { t: key => key };
        expect(terms.publishRefusal(oversized()).message).toBe(FALLBACK);
        globalThis.i18n = { t: () => { throw new Error('i18n not ready'); } };
        expect(terms.publishRefusal(oversized()).message).toBe(FALLBACK);
    });

    it('refuses oversized authored content, using UTF-8 bytes and the server limit', () => {
        const record = { goal: 'buildings', geometry: { buildings: [] }, buildingProposal: { notes: 'č'.repeat(5300000) } };
        expect(terms.publishRefusal(record)).toMatchObject({ code: 'too-large', maxBytes: 10 * 1024 * 1024 });
        record.buildingProposal.notes = 'small';
        expect(terms.publishRefusal(record)).toBeNull();
    });

    it('exposes the refusal and nothing else: terms and kinds are not a design\'s', () => {
        expect(Object.keys(terms)).toEqual(['publishRefusal']);
        expect(Object.isFrozen(terms)).toBe(true);
    });
});
