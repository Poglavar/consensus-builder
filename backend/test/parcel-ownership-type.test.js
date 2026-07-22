// Unit tests for the frontend's parcel ownership classification (pure string matching — no DOM).
// This replaces the `ownership classification functions exist` check in
// e2e/tests/parcel-selection.spec.ts, which booted Chromium only to run `typeof fn === 'function'`
// and asserted nothing about how a label is actually classified.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalizeOwnerLabel,
    normalizeOwnerLabelLoose,
    isCityOwnedLabel,
    classifyOwnershipLabel,
    getOwnershipType
} = require('../../frontend/js/parcels/ownership-type.js');

describe('owner label normalisation', () => {
    it('uppercases, collapses whitespace and strips diacritics', () => {
        expect(normalizeOwnerLabel('  Čistoća   grada  ')).toBe('CISTOCA GRADA');
    });

    it('the loose form also strips punctuation, so `d.o.o.` matches `D O O`', () => {
        expect(normalizeOwnerLabelLoose('Nekretnine d.o.o.')).toBe('NEKRETNINE D O O');
    });

    it('returns an empty string for empty input', () => {
        expect(normalizeOwnerLabel(null)).toBe('');
        expect(normalizeOwnerLabelLoose(undefined)).toBe('');
    });
});

describe('classifyOwnershipLabel', () => {
    it('classifies national and city government owners as government', () => {
        expect(classifyOwnershipLabel('REPUBLIKA HRVATSKA')).toBe('government');
        expect(classifyOwnershipLabel('Grad Zagreb')).toBe('government');
        expect(classifyOwnershipLabel('Dom zdravlja Zagreb')).toBe('government');
    });

    it('matches the city regex through inflected forms', () => {
        expect(classifyOwnershipLabel('U vlasništvu GRADA ZAGREBA')).toBe('government');
    });

    it('classifies religious and civic bodies as institutions', () => {
        expect(classifyOwnershipLabel('Zagrebačka nadbiskupija')).toBe('institution');
        expect(classifyOwnershipLabel('Udruga za urbanizam')).toBe('institution');
        // Hrvatska matica iseljenika is a cultural institution, not a private individual.
        expect(classifyOwnershipLabel('HRVATSKA MATICA ISELJENIKA')).toBe('institution');
    });

    it('classifies companies by their legal-form marker', () => {
        expect(classifyOwnershipLabel('Nekretnine d.o.o.')).toBe('company');
        expect(classifyOwnershipLabel('Zagrebačka banka d.d.')).toBe('company');
    });

    it('falls back to private individual for a personal name, and for no owner at all', () => {
        expect(classifyOwnershipLabel('Ivan Horvat')).toBe('private individual');
        expect(classifyOwnershipLabel('')).toBe('private individual');
        expect(classifyOwnershipLabel(null)).toBe('private individual');
    });

    it('government wins over the company marker when both are present', () => {
        // HEP D.D. is an explicit government keyword — it must not be demoted to `company`.
        expect(classifyOwnershipLabel('HEP d.d.')).toBe('government');
    });

    it('classifies the coastal city owners the backend list carried (the drift bug)', () => {
        // These three keywords lived only in the backend copy, so a GRAD TROGIR parcel read as
        // government via the API and as a private individual in the browser.
        expect(classifyOwnershipLabel('GRAD TROGIR')).toBe('government');
        expect(classifyOwnershipLabel('Grad Kaštela')).toBe('government');
        expect(classifyOwnershipLabel('Srednja škola Ban Josip Jelačić')).toBe('government');
    });

    it('preserveCity distinguishes the owning city from other government', () => {
        expect(classifyOwnershipLabel('Grad Zagreb', { preserveCity: true })).toBe('city');
        expect(classifyOwnershipLabel('Grad Zagreb')).toBe('government');
        // A non-city government owner stays government even with preserveCity.
        expect(classifyOwnershipLabel('REPUBLIKA HRVATSKA', { preserveCity: true })).toBe('government');
    });

    it('getOwnershipType is the single-argument alias', () => {
        expect(getOwnershipType('REPUBLIKA HRVATSKA')).toBe('government');
        expect(getOwnershipType('Ivan Horvat')).toBe('private individual');
    });
});

describe('isCityOwnedLabel', () => {
    it('is true only for city-of-Zagreb owners, not for the state', () => {
        expect(isCityOwnedLabel('Grad Zagreb')).toBe(true);
        expect(isCityOwnedLabel('GRADA ZAGREBA')).toBe(true);
        expect(isCityOwnedLabel('REPUBLIKA HRVATSKA')).toBe(false);
        expect(isCityOwnedLabel('Ivan Horvat')).toBe(false);
        expect(isCityOwnedLabel('')).toBe(false);
    });
});
