// Complete translated dictionaries, locale formatting and language-specific plural selection.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dictionary, testI18n } from './helpers/i18n.js';

const format = createRequire(import.meta.url)('../../frontend/js/format.js');
function flatten(node, prefix = '', output = {}) {
    for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') flatten(value, path, output);
        else output[path] = value;
    }
    return output;
}
const english = flatten(dictionary('en'));
const placeholders = text => [...new Set([...text.matchAll(/\{\{\s*\w+\s*\}\}|\{\w+\}/g)].map(match => match[0]))].sort();
const tags = text => text.match(/<\/?[a-zA-Z][^>]*>/g) || [];
for (const language of ['ar', 'fr', 'pt', 'ru', 'kk']) {
    describe(`${language} dictionary`, () => {
        const selected = flatten(dictionary(language));
        it('translates every English key and preserves exact parameters and markup', () => {
            const failures = [];
            for (const [key, source] of Object.entries(english)) {
                const value = selected[key];
                if (typeof value !== 'string' || (!value.trim() && source.trim())) { failures.push(`${key}: missing`); continue; }
                if (JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(source))) failures.push(`${key}: parameters`);
                if (JSON.stringify(tags(value)) !== JSON.stringify(tags(source))) failures.push(`${key}: markup`);
                if (/[\u202A-\u202E\u2066-\u2069]/u.test(value)) failures.push(`${key}: embedded direction controls`);
            }
            expect(failures).toEqual([]);
        });
        it('uses its registry locale for numbers and dates', () => {
            const previous = globalThis.window;
            const api = testI18n(language);
            globalThis.window = { i18n: api };
            try {
                expect(format.localeFor()).toBe(api.getLocale());
                expect(new Intl.DateTimeFormat(api.getLocale()).resolvedOptions().calendar).toBe('gregory');
                expect(format.formatNumber(12345.5, { maxFractionDigits: 1 }))
                    .toBe(new Intl.NumberFormat(api.getLocale(), { maximumFractionDigits: 1 }).format(12345.5));
                const date = new Date('2026-10-27T12:00:00Z');
                expect(format.formatDate(date, { timeZone: 'UTC' }))
                    .toBe(new Intl.DateTimeFormat(api.getLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(date));
            } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
        });
    });
}

describe('Arabic plurals', () => {
    const arabic = flatten(dictionary('ar'));
    // A plural group has a .one form or counts; a key merely named `other` (agreement.neighbours.right.other,
    // "Another right") is not one. The same rule as the Russian check below.
    const groups = Object.keys(english).filter(key => key.endsWith('.other')).map(key => key.slice(0, -6))
        .filter(group => english[`${group}.one`] || placeholders(english[`${group}.other`]).some(param => /\bcount\b/.test(param)));
    it('defines every CLDR category for every English plural group', () => {
        const missing = [];
        for (const group of groups) for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) {
            if (!arabic[`${group}.${form}`]?.trim()) missing.push(`${group}.${form}`);
        }
        expect(missing).toEqual([]);
    });
    it('renders zero, singular, dual, few, many and other from the real dictionary', () => {
        const api = testI18n('ar');
        const key = 'proposals.autoName.parcels';
        for (const [count, form] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']]) {
            expect(api.t(key, { count })).toBe(arabic[`${key}.${form}`].replace(/\{\{\s*count\s*\}\}|\{count\}/g, String(count)));
        }
    });
});

describe('Russian plurals', () => {
    const russian = flatten(dictionary('ru'));
    const groups = Object.keys(english).filter(key => key.endsWith('.other')).map(key => key.slice(0, -6))
        .filter(group => english[`${group}.one`] || placeholders(english[`${group}.other`]).some(param => /\bcount\b/.test(param)));
    it('defines each Russian plural form', () => {
        const missing = groups.flatMap(group => ['one', 'few', 'many', 'other']
            .map(form => `${group}.${form}`).filter(key => !russian[key]?.trim()));
        expect(missing).toEqual([]);
    });

    it.each([[1, '1 участок'], [2, '2 участка'], [5, '5 участков'], [21, '21 участок']])(
        'inflects the parcel count %s', (count, title) => {
            expect(testI18n('ru').t('proposals.autoName.parcels', { count })).toBe(title);
        }
    );
});

it('names Alatau in Kazakh and keeps the noun singular after a number', () => {
    const api = testI18n('kk');
    expect(api.t('city.labels.alatau')).toBe('Алатау, Қазақстан');
    for (const count of [0, 1, 2, 21]) {
        expect(api.t('proposals.autoName.parcels', { count })).toBe(`${count} жер учаскесі`);
    }
});
