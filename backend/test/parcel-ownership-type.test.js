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
    normalizeCanonicalOwnerType,
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
        expect(classifyOwnershipLabel('Javno dobro')).toBe('government');
    });

    it('matches the city regex through inflected forms', () => {
        expect(classifyOwnershipLabel('U vlasništvu GRADA ZAGREBA')).toBe('government');
    });

    it('classifies religious and civic bodies as institutions', () => {
        expect(classifyOwnershipLabel('Zagrebačka nadbiskupija')).toBe('institution');
        expect(classifyOwnershipLabel('Udruga za urbanizam')).toBe('institution');
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

    it('recognizes known New York public bodies without treating generic city wording as public', () => {
        expect(classifyOwnershipLabel('City of New York')).toBe('government');
        expect(classifyOwnershipLabel('New York City Housing Authority')).toBe('government');
        expect(classifyOwnershipLabel('New York City Transit Authority')).toBe('government');
        expect(classifyOwnershipLabel('NYC Department of Environmental Protection')).toBe('government');
        expect(classifyOwnershipLabel('New York City Dept. of Transportation')).toBe('government');
        expect(classifyOwnershipLabel('NYC Dept of Parks and Recreation')).toBe('government');
        expect(classifyOwnershipLabel('New York City Ventures LLC')).toBe('company');
        expect(classifyOwnershipLabel('City of Chicago Holdings LLC')).toBe('company');
        expect(classifyOwnershipLabel('City Living LLC')).toBe('company');
        expect(classifyOwnershipLabel('NYC Department Store LLC')).toBe('company');
    });

    it('recognizes common US company suffixes and leaves unmarked names alone', () => {
        expect(classifyOwnershipLabel('Acme Holdings LLC')).toBe('company');
        expect(classifyOwnershipLabel('Example Services, Inc.')).toBe('company');
        expect(classifyOwnershipLabel('Acme Real Estate')).toBe('private individual');
    });

    it('preserves canonical owner types instead of interpreting them as owner labels', () => {
        expect(normalizeCanonicalOwnerType(' company ')).toBe('company');
        expect(normalizeCanonicalOwnerType('GOVERNMENT')).toBe('government');
        expect(normalizeCanonicalOwnerType('private individual')).toBe('private individual');
        expect(normalizeCanonicalOwnerType('city')).toBe('government');
        expect(normalizeCanonicalOwnerType('New York City Housing Authority')).toBeNull();
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
