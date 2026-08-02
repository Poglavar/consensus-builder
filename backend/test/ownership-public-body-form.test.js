// A city owns land under its own name, and we should not need to know the city's name in advance.
//
// GOVERNMENT_KEYWORDS enumerates them one at a time — GRAD ZAGREB, GRAD KAŠTELA, GRAD TROGIR — so
// every city added after those reads its own land as privately owned until somebody remembers to
// add a line. Šibenik launched exactly that way: GRAD ŠIBENIK, GRAD VODICE, OPĆINA BILICE and
// OPĆINA TRIBUNJ all classified 'private individual', which is the opposite of true and feeds the
// map's ownership colouring and the city-owned-land figures.
//
// Croatian local government names its land by FORM, so match the form. The risk in doing that is
// over-matching, and both real cases are pinned below.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyOwnershipLabel } = require('../../frontend/js/parcels/ownership-type.js');

describe('public bodies are recognised by form, not by an enumerated list', () => {
    it('classifies any city or municipality, including ones never listed', () => {
        // None of these appear in GOVERNMENT_KEYWORDS.
        for (const label of ['GRAD ŠIBENIK', 'Grad Vodice', 'OPĆINA BILICE', 'Općina Tribunj',
            'GRAD ZADAR', 'GRAD SAMOBOR', 'GRAD POŽEGA', 'GRAD VELIKA GORICA']) {
            expect(classifyOwnershipLabel(label), label).toBe('government');
        }
    });

    it('handles the address suffix the registry appends to an owner name', () => {
        expect(classifyOwnershipLabel('GRAD ŠIBENIK, TRG P. ŠUBIĆA I. BR 2 ŠIBENIK')).toBe('government');
        expect(classifyOwnershipLabel('GRAD VELIKA GORICA, VELIKA GORICA, TRG KRALJA TOMISLAVA 34')).toBe('government');
    });

    it('classifies counties, whose name puts ŽUPANIJA last', () => {
        expect(classifyOwnershipLabel('ŠIBENSKO-KNINSKA ŽUPANIJA')).toBe('government');
        expect(classifyOwnershipLabel('ZAGREBAČKA ŽUPANIJA')).toBe('government');
    });

    it('does NOT catch a private person whose address contains a street named after a city', () => {
        // Real owner label from the Zagreb data. An unanchored /GRADA \w+/ turns him into the state.
        expect(classifyOwnershipLabel('FERDO VIDOVIĆ, ULICA GRADA CHICAGA 24, ZAGREB'))
            .toBe('private individual');
    });

    it('does NOT catch GRAĐA / GRAĐEVINSKI, which are a different word from GRAD', () => {
        // Both real labels from the Zagreb data. 'GRAĐA' is building material, not a city; the loose
        // normaliser drops Đ to a space, so these never look like 'GRAD <place>'.
        expect(classifyOwnershipLabel('GRAĐA POD.ZA PROMET GRAĐ.MATERIJALA')).not.toBe('government');
        expect(classifyOwnershipLabel('GRAĐ.ŠKOLSKI CENTAR')).not.toBe('government');
    });

    it('leaves ordinary people and companies alone', () => {
        expect(classifyOwnershipLabel('IVAN HORVAT')).toBe('private individual');
        expect(classifyOwnershipLabel('LABURA DANE, P. JOSE')).toBe('private individual');
    });
});
