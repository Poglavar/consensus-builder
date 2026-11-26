// Covers storey numbering (frontend/js/storey-numbering.js): a storey level as the words a reader's
// locale uses, ground floor then Floor 1 ('ground-zero') or Floor 1 at street level ('ground-one'),
// and which locales count which way (i18n.js LOCALE_CHOICES).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { testI18n } from './helpers/i18n.js';

const require = createRequire(import.meta.url);
const storeys = require('../../frontend/js/storey-numbering.js');

// The dictionary lookup the callers pass in: t(key, fallback, params) with the fallback interpolated.
const translator = api => (key, fallback, params) => {
    const value = api.t(key, params);
    return value === key ? fallback : value;
};

describe('storeyOf', () => {
    it('counts the ground floor as 0 and the storey above it as Floor 1 in ground-zero locales', () => {
        expect(storeys.storeyOf(0, 'ground-zero')).toEqual({ kind: 'ground', number: 0 });
        expect(storeys.storeyOf(1, 'ground-zero')).toEqual({ kind: 'storey', number: 1 });
        expect(storeys.storeyOf(7, 'ground-zero')).toEqual({ kind: 'storey', number: 7 });
        expect(storeys.storeyOf(-1, 'ground-zero')).toEqual({ kind: 'basement', number: 1 });
        expect(storeys.storeyOf(-2, 'ground-zero')).toEqual({ kind: 'basement', number: 2 });
    });

    it('counts the storey at street level as Floor 1 in ground-one locales, basements unchanged', () => {
        expect(storeys.storeyOf(0, 'ground-one')).toEqual({ kind: 'storey', number: 1 });
        expect(storeys.storeyOf(1, 'ground-one')).toEqual({ kind: 'storey', number: 2 });
        expect(storeys.storeyOf(7, 'ground-one')).toEqual({ kind: 'storey', number: 8 });
        expect(storeys.storeyOf(-1, 'ground-one')).toEqual({ kind: 'basement', number: 1 });
    });

    it('defaults to ground-zero without the i18n runtime and refuses a level that is not a storey', () => {
        expect(storeys.current()).toBe('ground-zero');
        expect(storeys.storeyOf(0)).toEqual({ kind: 'ground', number: 0 });
        expect(() => storeys.storeyOf(null, 'ground-zero')).toThrow(/integer/);
        expect(() => storeys.storeyOf(1.5, 'ground-zero')).toThrow(/integer/);
        expect(() => storeys.storeyOf(1, 'ground-two')).toThrow(/convention/);
    });

    it('gives compact templates the storey number, and the level for the ground floor and basements', () => {
        expect([-1, 0, 1, 2].map(level => storeys.storeyFigure(level, 'ground-zero'))).toEqual([-1, 0, 1, 2]);
        expect([-1, 0, 1, 2].map(level => storeys.storeyFigure(level, 'ground-one'))).toEqual([-1, 1, 2, 3]);
    });
});

describe('storey labels by locale', () => {
    it('numbers Russian and Kazakh storeys from 1 at street level; English, Croatian and the rest from the ground floor', () => {
        const of = lang => { const api = testI18n(lang.split('-')[0]); api.setLanguage(lang, { persist: false }); return api.getStoreyNumbering(); };
        expect(['en', 'en-US', 'hr', 'sr', 'es', 'fr', 'pt', 'ar'].map(of)).toEqual(Array(8).fill('ground-zero'));
        expect(['ru', 'kk', 'es-CO'].map(of)).toEqual(['ground-one', 'ground-one', 'ground-one']);
    });

    it('writes English storeys as Ground floor, Floor 1 and Basement 1', () => {
        const api = testI18n('en'), t = translator(api);
        const convention = api.getStoreyNumbering();
        expect([-1, 0, 1, 2].map(level => storeys.storeyLabel(level, t, convention))).toEqual(['Basement 1', 'Ground floor', 'Floor 1', 'Floor 2']);
    });

    it('writes the Russian storey at street level as floor 1 and never as the ground floor', () => {
        const api = testI18n('ru'), t = translator(api);
        const convention = api.getStoreyNumbering();
        const floor = number => api.t('threeMode.controls.floorLevel', { level: number });
        expect(storeys.storeyLabel(0, t, convention)).toBe(floor(1));
        expect(storeys.storeyLabel(1, t, convention)).toBe(floor(2));
        expect(storeys.storeyLabel(-1, t, convention)).toBe(api.t('threeMode.controls.floorBasement', { level: 1 }));
        expect(storeys.storeyLabel(0, t, convention)).not.toBe(api.t('threeMode.controls.floorGround'));
        expect(storeys.storeyLabel(0, t, convention)).toMatch(/1/);
    });

    it('writes the Kazakh storey at street level as floor 1', () => {
        const api = testI18n('kk'), t = translator(api);
        expect(storeys.storeyLabel(0, t, api.getStoreyNumbering())).toBe(api.t('threeMode.controls.floorLevel', { level: 1 }));
    });
});
