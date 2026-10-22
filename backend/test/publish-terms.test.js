// Unit tests for frontend/js/proposals/publish-terms.js: the one choke point that says whether a design
// may be published on its own (plan-design-agreement.md, M2). Only a parcel layout is refused; it
// leaves the device with the agreement that settles its land.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const terms = require('../../frontend/js/proposals/publish-terms.js');

const FALLBACK = 'A parcel layout is published with its agreement. Propose an agreement that includes it.';

describe('publishRefusal', () => {
    afterEach(() => { delete globalThis.i18n; });

    it('refuses a parcel layout with the index\'s own refusal code', () => {
        expect(terms.publishRefusal({ goal: 'parcel-layout', parcelLayout: { plots: [] } }))
            .toEqual({ code: 'layout-needs-agreement', message: FALLBACK });
    });

    it('lets every other design, and nothing at all, through', () => {
        for (const record of [{ goal: 'park' }, { goal: 'road-track' }, { goal: 'single' }, { goal: 'urban-rule' }, {}, null, undefined]) {
            expect(terms.publishRefusal(record)).toBeNull();
        }
        // The goal decides, not the payload: a layout payload on another goal is not a layout.
        expect(terms.publishRefusal({ goal: 'park', parcelLayout: { plots: [] } })).toBeNull();
    });

    it('words the refusal in the page language, and falls back when the key is missing or the lookup fails', () => {
        const asked = [];
        globalThis.i18n = { t: key => { asked.push(key); return 'Raspored čestica objavljuje se sa svojim sporazumom.'; } };
        expect(terms.publishRefusal({ goal: 'parcel-layout' }).message).toBe('Raspored čestica objavljuje se sa svojim sporazumom.');
        expect(asked).toEqual(['parcelLayout.publishWithAgreement']);

        globalThis.i18n = { t: key => key };
        expect(terms.publishRefusal({ goal: 'parcel-layout' }).message).toBe(FALLBACK);
        globalThis.i18n = { t: () => { throw new Error('i18n not ready'); } };
        expect(terms.publishRefusal({ goal: 'parcel-layout' }).message).toBe(FALLBACK);
    });

    it('exposes the refusal and nothing else: terms and kinds are not a design\'s', () => {
        expect(Object.keys(terms)).toEqual(['publishRefusal']);
        expect(Object.isFrozen(terms)).toBe(true);
    });
});
